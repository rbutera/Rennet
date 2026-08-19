# Tasks — tray-presence

## 1. Assets

- [ ] 1.1 Generate + check in `brand/exports/tray/`: macOS `rennetTemplate.png`/`@2x` (black+alpha from `mark-small-black.svg`) and update-ready variants (baked dot); Windows `rennet.ico` + update variant; derivation note in brand docs. Verify 16px legibility (screenshot in PR; square-glyph fallback per design risk).

## 2. Owned-daemon stop seam

- [ ] 2.1 `stopOwnedDaemon(dataDir)` in the desktop supervisor module mirroring `rennet stop` (claim read → SIGTERM → bounded claim-gone poll → truthful timeout warning); unit tests incl. no-claim no-op and timeout path.

## 3. Tray module

- [ ] 3.1 `apps/desktop/src/main/tray.ts`: pure menu-template derivation from `{ownedDaemonRunning, updateReady, version}` (exported, unit-tested across all four states) + thin Electron wiring (Tray, nativeImage template, icon variant swap).
- [ ] 3.2 Residency: `window-all-closed` flips to tray-resident (no quit; macOS dock hide); `ensureWindow()` shared by tray Open and macOS `activate` (focus-or-recreate, dock show); `isQuitting` flag so real quit closes cleanly; tests (close does not quit; open recreates).
- [ ] 3.3 Quit action: `stopOwnedDaemon` (when owned claim present) then app exit; label derived truthfully ("Quit Rennet and stop daemon" / "Quit Rennet"); tests for both label states and quit-with-no-daemon.
- [ ] 3.4 Update surface: tray subscribes to the existing readiness store in main; icon variant + "Restart Rennet to update" line only when staged; line invokes the existing apply path; test (readiness flip → template gains/loses the line).

## 4. Glossary, ADR, docs

- [ ] 4.1 Root `CONTEXT.md`: owned daemon, attached daemon, tray-resident, update-ready (glossary only).
- [ ] 4.2 `docs/adr/0001-tray-quit-owns-the-daemon.md` per design decision 6.
- [ ] 4.3 Docs same-change: tray section in the settings/getting-started guide (incl. Windows close-to-tray note), architecture-overview shell note, delivery-order entry.

## 5. Close-out

- [ ] 5.1 Existing `daemon-lifecycle.test.ts` + `auto-update.test.ts` pass unchanged; full `pnpm check` exit code captured directly; `openspec validate tray-presence --strict`. NO push; reviewer opens the PR.
