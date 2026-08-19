# Tray presence

## Why

Rennet's daemon already outlives the app (#379), reviews stream in the background, and updates stage silently — but the desktop app has no ambient presence: closing the window quits the shell, there is no way to fully stop Rennet (app + its daemon) without the CLI, and the staged update is only visible inside an open window. A tray icon (macOS menu bar, Windows tray) gives the resident daemon a resident face: open, quit completely, and restart-to-update from the same place. Decided with Rai 2026-08-19 (grill session; all decisions recorded in design.md).

## What Changes

- **Tray-resident shell**: closing the last window no longer quits the app — it stays in the tray, daemon and streams untouched; on macOS the Dock icon hides while window-less (accessory policy) and returns on reopen. Window close still stops nothing (#379 invariant preserved).
- **Tray menu (minimal)**: Open Rennet (focus or recreate) · "Restart Rennet to update" shown only when update-ready · version line · Quit item whose copy states truthfully what it kills ("Quit Rennet" / "Quit Rennet and stop daemon").
- **Quit completely**: SIGTERMs the **owned** daemon (the one claimed by `daemon.json` in the app's data dir — even if CLI-spawned), riding the daemon's existing graceful `shutdown()` (turns abort → persist interrupted, resumable); then the app exits. No prompt. An **attached** remote daemon is never touched.
- **Update surface**: the tray consumes the existing main-process update readiness (`update-electron-app` flow — the same state the in-app ChromeMark badge renders); the icon gains a dot variant only when update-ready; the menu line runs the existing `quitAndInstall` path. No new updater, no new feed; macOS stays dormant until signing (#298/#42), Windows already live.
- **Brand assets**: menu-bar Template images (16/32 @1x/@2x, alpha) generated from `mark-small-black.svg` + a Windows tray icon, checked into `brand/exports`; update-ready variants baked as second images.
- **Glossary + ADR**: root `CONTEXT.md` gains the crystallized terms (owned vs attached daemon, tray-resident, update-ready); ADR "tray Quit owns the daemon; window close never does" records the deliberate, scoped reintroduction of a teardown path #379 removed.
- **Non-goals**: launch-at-login/start-hidden, needs-you tray badges, pause-notifications, recent-review submenu, tray for headless `rennet serve`.

## Capabilities

### New Capabilities

- `tray-presence`: the desktop shell's ambient presence — tray icon and menu, tray residency on window close, the owned-daemon quit semantics, and the tray's update-ready surface.

### Modified Capabilities

<!-- none: window-close residency and quit semantics are new shell behavior owned by the new capability; the updater and daemon lifecycle are consumed, not changed -->

## Impact

- `apps/desktop/src/main` (tray module, window-all-closed/activate handling, quit path calling the supervisor's stop; auto-update readiness consumed in main), `apps/desktop/src/main/daemon-supervisor.ts` (an owned-daemon stop helper mirroring `rennet stop`).
- `brand/exports` new tray assets (+ generation note in brand docs).
- Docs same-change: settings-and-setup/getting-started tray section, architecture-overview shell note, delivery-order entry; `CONTEXT.md`; `docs/adr/0001-tray-quit-owns-the-daemon.md`.
- No protocol, server, ui-package, or mobile changes. Existing daemon-lifecycle and auto-update tests extended, not rewritten.
