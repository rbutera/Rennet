# Tasks — update-notification-badge

## 1. Main process: poll cadence + readiness state

- [x] 1.1 In `apps/desktop/src/main/auto-update.ts`, change `updateElectronApp` to `{ updateInterval: "5 minutes", notifyUser: false, logger }`, keep the best-effort try/catch + error listener, and add an `autoUpdater.on("update-downloaded")` listener that caches readiness state `{ version }` (parsed from release name when present) and broadcasts `rennet:update-ready` to all windows.
- [x] 1.2 In `apps/desktop/src/main/index.ts`, register the `rennet:update-ready` replay (send cached state to a window that subscribes/loads late) and an `rennet:update-apply` `ipcMain.on` handler calling `autoUpdater.quitAndInstall()`, following the sender-validation idiom of the existing menu channels.
- [x] 1.3 Unit-cover the readiness cache: downloaded → broadcast + cached; late window → replayed; no download → nothing sent; apply handler routes to quitAndInstall (mock `electron`'s autoUpdater as the existing desktop tests do).

## 2. Preload: host surface

- [x] 2.1 Extend `RennetPreload` in `apps/desktop/src/preload/index.ts` with `onUpdateReady(listener: (info: { version?: string }) => void): () => void` (subscribe + immediate replay of cached state, zod-parsed payload like `onMenuRun`) and `applyUpdate(): void` (one-way send).
- [x] 2.2 Cover the new preload members in the existing preload test file (payload parse rejects malformed, unsubscribe removes listener).

## 3. UI: badge + prompt

- [x] 3.1 In `packages/ui`, subscribe once in the app shell via optional `window.rennet?.onUpdateReady`; hold `updateReady` state; absent host surface (browser shell, tests) leaves the feature inert.
- [x] 3.2 When ready, render the corner badge on the chrome `RennetBrandMark` sites (app.tsx topbars + front-door): logo becomes a button with an `aria-label` naming the action ("Update ready — restart into <version>"), badge is a non-text dot (pill exemption, `--accent`), never color-alone (the label carries meaning).
- [x] 3.3 Clicking opens the in-app confirm using the existing dialog idiom: "Restart into <version>?" with Apply / Not now; Apply calls `window.rennet.applyUpdate()`, Not now closes and keeps the badge; no self-re-prompting.
- [x] 3.4 New CSS stays on-system: ramp sizes, radius scale (dot = 50% or 999px exemption), ink text on opaque grounds; classify any new hue text in the tokens.test.ts guard or use ink.
- [x] 3.5 DOM tests (app.*.dom.test.tsx style): no host surface → no badge and logo unchanged; ready event → badge + aria-label on all chrome sites; click → prompt; Apply → applyUpdate called; Not now → prompt closes, badge persists; late-replay path (state set before mount) badges.

## 4. Gate + docs

- [x] 4.1 Run the package gates (scoped `pnpm exec vitest run src` in packages/ui, desktop test target, then `pnpm check`) — all green with the new tests counted.
- [x] 4.2 Update the docsite page that describes updates/releases (search `docs/src/content/docs` for auto-update/release copy) so the 5-minute cadence, badge, and click-to-restart flow are documented in the same change; honest-egress copy still names update.electronjs.org/GitHub as the only endpoints.
