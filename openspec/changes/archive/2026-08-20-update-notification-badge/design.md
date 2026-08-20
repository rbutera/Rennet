# Design — update-notification-badge

## Context

- `apps/desktop/src/main/auto-update.ts` already wires `update-electron-app` 3.3.0 at a 1-hour interval with its default `notifyUser` dialog, wrapped in the best-effort posture (unsigned macOS throws are swallowed; issue #42).
- The preload exposes a small Electron-native surface as `window.rennet` (`RennetPreload`): platform, wsPort, menu channels, `chooseDirectory`. Adding host capabilities means adding to this surface — the WS bridge is for daemon traffic, not Electron-native events.
- The Rennet logo renders via `RennetBrandMark` at five chrome sites (`app.tsx` topbars ×4, `front-door.tsx`); `settings-screen.tsx`'s mark is an about-panel illustration, not chrome.
- The UI also ships in a daemon-served browser shell where `window.rennet` is absent.

## Goals / Non-Goals

**Goals:**
- 5-minute poll, badge-on-logo readiness signal, click-to-prompt apply — per the spec.
- Zero behavior change where the updater can't run.

**Non-Goals:**
- No changes to the release pipeline, endpoint, or signing posture (#42 stays as-is).
- No settings toggle, no snooze persistence, no in-app changelog. The badge and a two-choice prompt are the whole surface.
- No update UI in the browser shell.

## Decisions

1. **Keep `update-electron-app`, turn its dialog off.** `updateElectronApp({ updateInterval: "5 minutes", notifyUser: false })` — 5 minutes is the library's documented minimum, and `notifyUser: false` disables the stock modal while keeping the poll/download loop. Alternative (hand-rolled `autoUpdater.setFeedURL` + timer) rejected: reimplements what the dependency already does (ladder rung 5).
2. **Readiness signal = `autoUpdater.on("update-downloaded")` in main**, forwarded to the renderer over a new one-way channel `rennet:update-ready` carrying `{ version }` parsed from the release name when available. Late-subscriber safety: main caches the readiness state and the preload getter replays it, so a renderer that loads (or reloads) after download still badges.
3. **Preload surface grows two members** on `RennetPreload`, following the existing channel idiom: `onUpdateReady(listener): () => void` (subscribe + replay, like `onMenuRun`) and `applyUpdate(): void` (one-way send; main calls `autoUpdater.quitAndInstall()`). Zod-parse payloads at the boundary like the menu channels.
4. **UI: badge state lives in the app shell, prompt is in-app.** The shell subscribes once via the optional `window.rennet?.onUpdateReady` (absent in the browser shell and tests → feature never activates). When ready, the chrome logo sites render a corner dot badge (existing pill/dot idiom, `--accent`, plus an `aria-label` naming the action — never color alone) and the logo becomes a button. Clicking opens a small in-app confirm (existing sheet/dialog idiom): "Restart into <version>" / "Not now". Confirm → `window.rennet.applyUpdate()`. Dismiss → closes; badge stays. Alternative (native `dialog.showMessageBox` from main) rejected: the spec puts the interaction on the logo in the app chrome, and the in-app prompt matches the product's dialog language and testability.
5. **Contrast/ramp compliance:** badge dot is a non-text graphic on opaque chrome-adjacent ground; sized on-ramp (999px pill exemption applies to dots); any new text is ink on opaque surfaces per the tokens.test.ts guard, and new hue text (none planned) would need classification there.

## Risks / Trade-offs

- [5-minute polls hit update.electronjs.org more often] → the service is built for this cadence and it's the library minimum; still only version metadata per poll.
- [`update-downloaded` fires only after a download completes; a failed download never badges] → correct per spec (badge means *ready*); errors stay logged-only via the existing error listener.
- [Renderer reload after download misses the event] → replay from cached main-side state (Decision 2).
- [Unsigned macOS never badges] → intended; spec's graceful-absence requirement, unchanged from today.

## Migration Plan

Ships as a normal patch through auto-release; no data, settings, or protocol migration. Rollback = revert the commit. The first release carrying this feature is still discovered by the *old* hourly/stock-dialog updater on installed builds — the new cadence applies from the next release onward.
