# Tasks — add-browser-shell (#381)

## 1. Browser shell build

- [ ] 1.1 `apps/desktop/src/browser/{index.html,entry.tsx}` + `vite.browser.config.ts` → `dist/browser/` (react plugin, base "./", CSP meta per design D1), added to the desktop build target chain.
- [ ] 1.2 Browser composition per design D4/D5: bridge factory from location.host / saved targets; repository.choose path-prompt wrapper; no platform/menu members.

## 2. Daemon serves the UI

- [ ] 2.1 Static handler per design D2 (uiDist option, traversal guard ported from the old app-protocol handler, content types, index.html no-cache) slotted before the 404; unit tests: serves index at /, nested asset, traversal attempt 404s, headless (no uiDist) unchanged.
- [ ] 2.2 `rennet serve` default uiDist resolution (`../browser` beside the server bundle) + `--ui-dist` override; desktop-spawned daemon gets the same.
- [ ] 2.3 Packaging: asarUnpack `dist/browser/**`; package-smoke asserts GET / returns the page.

## 3. Connections surface (shared)

- [ ] 3.1 `ConnectionHost` in `packages/ui` per design D3: picker + indicator, saved daemons in localStorage, add-daemon flow with phase-4 pairing-code exchange, `RennetApp` remount keyed on active connection. DOM tests: default target renders app; switch remounts; add-daemon stores entry; absent localStorage no-ops.
- [ ] 3.2 Renderer swaps to ConnectionHost (local daemon default; remote targets via WsRennetBridge with token; menu residue per D4); CSP `connect-src` widened `ws: wss:`.
- [ ] 3.3 Browser entry mounts ConnectionHost (serving origin default).

## 4. Parity inventory

- [ ] 4.1 Test per design D6: every `commandDefinitions` key reaches dispatch over the WS request path; browser intercept allowlist exactly `["repository.choose"]` with asserted justification.

## 5. e2e

- [ ] 5.1 Playwright `browser` project (chromium) added to config; existing Electron specs/harness untouched.
- [ ] 5.2 `browser-review.spec.ts`: CLI-spawned daemon (isolated dataDir, fixture repo, model-free env) serves the ui; tab drives the local-review happy path; daemon teardown.
- [ ] 5.3 `NX_DAEMON=false pnpm check` green; Electron e2e failure set unchanged.

## 6. Docs + marketing (same change)

- [ ] 6.1 `using/guide/browser-rennet.md` (serve, open, picker, remote attach + Tailscale pointer, path-prompt caveat, editor-on-daemon-host semantics), sidebar-registered.
- [ ] 6.2 `architecture-overview.md`: two-shells diagram + prose.
- [ ] 6.3 `apps/marketing` index: browser-client story section (honest copy: local tab, Tailscale remote, no hosted anything).
