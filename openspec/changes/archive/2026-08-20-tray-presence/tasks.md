# Tasks — tray-presence

## 1. Assets

- [x] 1.1 Generate + check in `brand/exports/tray/`: macOS `rennetTemplate.png`/`@2x` (black+alpha from `mark-small-black.svg`) and update-ready variants (baked dot); Windows `rennet.ico` + update variant; derivation note in brand docs. Verify 16px legibility (screenshot in PR; square-glyph fallback per design risk).

## 2. Owned-daemon stop seam

- [x] 2.1 `stopOwnedDaemon(dataDir)` in the desktop supervisor module mirroring `rennet stop` (claim read → SIGTERM → bounded claim-gone poll → truthful timeout warning); unit tests incl. no-claim no-op and timeout path.

## 3. Tray module

- [x] 3.1 `apps/desktop/src/main/tray.ts`: pure menu-template derivation from `{ownedDaemonRunning, updateReady, version}` (exported, unit-tested across all four states) + thin Electron wiring (Tray, nativeImage template, icon variant swap).
- [x] 3.2 Residency: `window-all-closed` flips to tray-resident (no quit; macOS dock hide, coordinated so a too-soon hide is deferred past the ~1s no-op window); `ensureWindow()` shared by tray Open and macOS `activate` (focus-or-recreate, dock show); tests (close does not quit; open recreates; dock hide/show ordering). No `isQuitting` flag: post-#379 nothing intercepts window `close` or `before-quit` (there is no close-to-hide handler to fight), so the flag would be dead code — real quit already closes cleanly. The one `will-quit` handler only destroys the retained tray.
- [x] 3.3 Quit action: `stopOwnedDaemon` (when owned claim present) then app exit; label derived truthfully ("Quit Rennet and stop daemon" / "Quit Rennet"); tests for both label states and quit-with-no-daemon.
- [x] 3.4 Update surface: tray subscribes to the existing readiness store in main; icon variant + "Restart Rennet to update" line only when staged; line invokes the existing apply path; test (readiness flip → template gains/loses the line).

## 4. Glossary, ADR, docs

- [x] 4.1 Root `CONTEXT.md`: owned daemon, attached daemon, tray-resident, update-ready (glossary only).
- [x] 4.2 `docs/adr/0001-tray-quit-owns-the-daemon.md` per design decision 6.
- [x] 4.3 Docs same-change: tray section in the settings/getting-started guide (incl. Windows close-to-tray note), architecture-overview shell note, delivery-order entry.

## 5. Close-out

- [x] 5.1 Existing `daemon-lifecycle.test.ts` + `auto-update.test.ts` pass unchanged; full `pnpm check` exit code captured directly; `openspec validate tray-presence --strict`. NO push; reviewer opens the PR.

## Deferred (recorded honestly, not claimed as done)

- The full "close the window mid-stream, reopen from the tray, stream still painting current
  state" scenario (spec scenario "close then reopen mid-stream") is NOT covered by an
  automated e2e. Playwright's `_electron` cannot reach a native menu-bar/tray item (it is not
  in the page DOM), and asserting "still streaming" needs a live review turn running — that is
  genuine e2e-land the current infra (`apps/desktop/e2e`, launch-and-drive-the-renderer) cannot
  host cheaply or truthfully. The reattach mechanism itself is covered where it lives: the
  window-recreation/focus derivation (`ensureWindow` unit tests) and the WS bridge re-dial
  (phase-2 transport contract tests). Revisit if the e2e harness gains tray/native-menu driving.
