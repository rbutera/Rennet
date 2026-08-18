# Update Notification Badge

## Why

Releases ship continuously through auto-release (a merge to `main` cuts a patch release within minutes), but the desktop app only checks hourly and surfaces the update through update-electron-app's stock modal dialog — easy to dismiss, easy to miss, and disconnected from the product's own chrome. Users sit on stale builds without knowing a newer Rennet exists.

## What Changes

- The desktop app checks for a new release every 5 minutes instead of every hour.
- The stock update dialog is replaced by an in-app signal: when an update has been downloaded and is ready, the Rennet logo in the app chrome carries a notification badge on its corner.
- Clicking the badged logo prompts the user to restart into the update (apply now / not now). Applying restarts the app into the new version via Squirrel's quit-and-install.
- The renderer learns about update state through a new host bridge event; the browser shell and environments without an updater (unsigned macOS dev builds, Linux, `rennet-browser`) simply never emit it, so the UI degrades to today's behavior.

## Capabilities

### New Capabilities

- `desktop-update-notification`: how the desktop app polls for releases, signals update readiness on the Rennet logo, and applies the update on user confirmation — including the no-op posture on hosts where the updater is unavailable.

### Modified Capabilities

<!-- none: no existing spec covers update behavior -->

## Impact

- `apps/desktop/src/main/auto-update.ts`: interval change, `notifyUser` off, `update-downloaded` listener, quit-and-install IPC handler.
- `apps/desktop/src/main/index.ts` + preload: one new main→renderer event (update ready) and one renderer→main invoke (apply update).
- `packages/ui`: badge rendering on the chrome logo sites and the confirm-prompt interaction; host hook is optional so the browser shell is unaffected.
- No new dependencies (`update-electron-app` 3.3.0 already present). No Rennet backend; the poll continues to hit update.electronjs.org / GitHub Releases only, which existing copy already discloses.
- macOS remains a silent no-op until Developer ID signing lands (issue #42) — unchanged posture, now explicit in the spec.
