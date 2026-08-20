# Design — tray-presence

## Context

Facts from the 2026-08-19 recon: the shell has no Tray usage; `window-all-closed → app.quit()` (`apps/desktop/src/main/index.ts:247`); app quit deliberately stops nothing (#379 — no `before-quit` teardown); the daemon is spawned detached with a `daemon.json` claim + `/healthz` probe (`packages/server/src/supervise.ts`), `rennet stop` SIGTERMs the claimed pid and polls the claim away (`packages/server/src/cli.ts:214`), and SIGTERM triggers the daemon's graceful `shutdown()` (abortAll → persist interrupted → close stores/listener). The updater is `update-electron-app` in main (`apps/desktop/src/main/auto-update.ts`) with a readiness store pushed to the renderer badge (`packages/ui/src/components/update-ready.tsx`); macOS is a silent no-op until Developer-ID signing (#298/#42), win32 is live. Brand has monochrome marks (`brand/exports/logo/svg/mark-small-black.svg`, 128×72) but no pre-stripped Template icon.

Rai's decisions (grill session, 2026-08-19): tray-resident on close (both platforms); Dock hides while window-less; graceful no-prompt quit; quit kills only the owned daemon; minimal menu; icon dots only for update-ready; updater state shared, not duplicated; in-app badge already exists and is untouched.

## Goals / Non-Goals

**Goals:**

- One new main-process module owning tray lifecycle; every action rides an existing seam (window create/focus, supervisor stop, updater readiness/apply).
- Truthful copy computed from live state (owned-daemon presence, staged update).

**Non-Goals:**

- Launch-at-login / start-hidden; needs-you or notification state in the tray; recent-review submenu; any tray for headless `rennet serve`; no updater or feed changes; no renderer/ui-package changes (the in-app badge stays as is).

## Decisions

1. **`apps/desktop/src/main/tray.ts`** builds the tray from injected seams: `{ openWindow, appVersion, updateReadiness, ownedDaemon, quitCompletely }` — pure menu-template derivation exported for unit tests (the template from a given state), Electron wiring thin.
2. **Residency**: `window-all-closed` no longer quits — it flips residency (macOS `app.dock.hide()`; restore via `app.dock.show()` before window recreate). A small dock coordinator awaits `show()` before recreation and defers a hide that lands within ~1s of a show (macOS silently ignores it otherwise), cancelling that pending hide on a reopen. `activate` (macOS) and tray "Open Rennet" share one `ensureWindow()` (focus if exists, else recreate through the existing window-creation path). No `isQuitting` flag is needed: post-#379 nothing intercepts window `close` or registers `before-quit` (there is no close-to-hide handler to fight), so the flag would be dead code — real quit already closes cleanly. The only `will-quit` handler destroys the module-retained tray.
3. **Owned-daemon stop**: a `stopOwnedDaemon(dataDir)` helper in the supervisor module mirroring `rennet stop` exactly (read claim → SIGTERM → bounded poll for claim-gone → truthful warning on timeout). The quit action: stop owned daemon (if any) → `app.quit()`. Never touches remote connections. Label derivation: claim file present + healthy ⇒ "Quit Rennet and stop daemon".
4. **Update surface**: `startAutoUpdate`'s readiness store gains a main-process subscription (it already pushes to the renderer; the tray subscribes to the same store object — no IPC hop). Icon swaps to the update-ready variant on staged; menu line calls the existing apply path (`quitAndInstall` / win32 stub respawn) — the same code the renderer confirm triggers.
5. **Icons**: check in generated PNGs under `brand/exports/tray/` — macOS `rennetTemplate.png`/`@2x` (black+alpha, derived from `mark-small-black.svg`, height 16/32pt, width per aspect) and update-ready variants with a baked dot; Windows `rennet.ico` + update variant from the existing iconset PNGs. A small `brand/` note records the derivation command. `nativeImage.createFromPath` + `setTemplateImage(true)` on darwin.
6. **CONTEXT.md + ADR**: root `CONTEXT.md` glossary (owned daemon, attached daemon, tray-resident, update-ready — terms only, no implementation); `docs/adr/0001-tray-quit-owns-the-daemon.md` records why an explicit quit reintroduces a teardown #379 removed (scoped to the tray action; window close still stops nothing; alternatives: no daemon stop [CLI-only, rejected — the ask was "completely exit"], kill-all-reachable [rejected — a remote daemon belongs to its own machine]).
7. **Tests**: menu-template derivation (all four states: daemon×update); residency handler (window-all-closed does not quit, activate/open recreates); `stopOwnedDaemon` against a fake claim+process (mirrors existing `daemon-lifecycle.test.ts` style); quit-with-no-daemon exits without signaling anything. Existing auto-update and daemon-lifecycle suites must pass unchanged.

## Risks / Trade-offs

- **Close-to-tray surprises on Windows** (non-native convention): accepted by decision; the tray icon is always present so the app is findable; docs state it.
- **Quit racing the daemon's bounded death**: mirrors `rennet stop` — app exits after the bounded wait either way, warning logged; the claim-file protocol makes the next launch truthful regardless.
- **Template icon legibility** at 16px from a 128×72 mark: verify visually in the PR (screenshot); fall back to the square iconset glyph if the wide mark muddies.
- **Dock hide/show flicker** on rapid close/open: bounded by using dock.show() before window creation only when hidden.
