# Package the Rennet desktop app

Electron Forge builds Rennet for macOS and Windows. macOS builds produce a DMG and ZIP. Windows builds produce a Squirrel installer, update feed, and portable ZIP.

Both release workflows produce Developer ID signed, notarized, and stapled macOS artifacts. Windows artifacts remain unsigned until issue #330.

## Prerequisites

The macOS build requires:

- Apple Silicon macOS
- Xcode Command Line Tools
- The repository dependencies installed with `pnpm install --frozen-lockfile`

The DMG maker uses `macos-alias` and `fs-xattr`. The workspace lists both native packages under `onlyBuiltDependencies`, so pnpm builds them during installation.

The adapter build also compiles Rennet's first-party exclusive-namespace-move executable and rooted-landing Node-API addon with the exact-SHA `@electron/node-gyp` and the Xcode C toolchain. This is an explicit Nx build step, not a pnpm dependency lifecycle script.

## Build on macOS

```sh
pnpm install --frozen-lockfile
pnpm nx run rennet-desktop:make
```

Forge writes artifacts under `apps/desktop/out/make/`:

- `Rennet-<version>-arm64.dmg`
- `zip/darwin/arm64/Rennet-darwin-arm64-<version>.zip`

Run the packaged-application smoke test with:

```sh
pnpm nx run rennet-desktop:package-smoke
```

The smoke uses the installed payload, not `packages/adapters/dist`. It loads and constructs `Rennet.app/Contents/Resources/app.asar.unpacked/dist/server/native/darwin-arm64/rennet-rooted-landing.node`, inspects and reads a real file through the addon, closes the returned descriptor and host, then executes the sibling `rennet-exclusive-move` and verifies the move and bytes. A missing, unloadable, non-runnable, or behaviorally wrong artifact fails the smoke.

### Unsigned builds

Without Apple credentials, Forge applies an ad hoc signature. The application runs, but Gatekeeper identifies it as coming from an unknown developer. Open it once through the Finder context menu or approve it in System Settings under Privacy & Security.

### Developer ID builds

Copy `.env.release.example` to the ignored `.env.release.local`, fill the four values, and run the same `make` target through the release-env helper:

```sh
pnpm release:env -- pnpm nx run rennet-desktop:make
```

`APPLE_SIGNING_IDENTITY` selects Developer ID signing, hardened runtime, and `apps/desktop/entitlements.plist`. When all four variables are present, Forge also notarizes and staples `Rennet.app`. If only the identity is present, Forge signs the application but does not notarize it.

Forge processes the application before MakerDMG wraps it. The release workflows then sign, notarize, staple, and verify the final DMG as a separate distribution artifact.

Create the application-specific password at [appleid.apple.com](https://appleid.apple.com). Confirm the Developer ID Application certificate is in the login keychain with:

```sh
security find-identity -v -p codesigning
```

### Verify a Developer ID build

Verify the DMG and its mounted application:

```sh
DMG=$(ls apps/desktop/out/make/*.dmg | head -1)
MP=$(hdiutil attach "$DMG" -nobrowse -readonly | grep /Volumes | awk -F'\t' '{print $NF}')
APP="$MP"/Rennet.app
codesign --verify --strict --verbose=2 "$DMG"
xcrun stapler validate "$DMG"
spctl -a -vvv -t open --context context:primary-signature "$DMG"
codesign --verify --deep --strict --verbose=2 "$APP"
xcrun stapler validate "$APP"
spctl -a -vvv -t exec "$APP"
hdiutil detach "$MP"
```

For a valid notarized build, `codesign` reports `valid on disk`, `stapler` reports a valid ticket, and `spctl` reports `accepted` with `Notarized Developer ID` as the source. An ad hoc build passes the `codesign` check but fails the notarization and Gatekeeper checks.

## Release sequence

The root `package.json` version is authoritative. `apps/desktop/package.json` must match it. `pnpm release:check -- vX.Y.Z` rejects zero versions, malformed or mismatched tags, tags that do not point at `HEAD`, and dirty working trees.

For a manual release:

1. Run `node scripts/set-version.mjs X.Y.Z`, review the lockstep package-version changes, commit them, and create the annotated tag `vX.Y.Z` on that commit.
2. Push the commit and tag. A tag by itself does not run `.github/workflows/release.yml` or publish a release.
3. Dispatch **Release** with that tag. It runs the full gate, imports the certificate into a temporary keychain, builds, notarizes, staples, verifies, and publishes a GitHub Release containing the DMG, updater ZIP, checksums, and build provenance. The release becomes visible, and therefore available to `update.electronjs.org`, only after every preceding step passes.

`.github/workflows/auto-release.yml` remains the nightly and **ship now** path. It creates the version commit and tag, runs the same signed macOS build through the `release` environment, builds unsigned Windows artifacts, and publishes only after every build succeeds.

Both workflows then assert the outcome. `scripts/check-release-assets.mjs` reads the published asset list and requires each platform's installers by shape — extension, platform token, and version — failing with the platform that shipped nothing. Shape rather than exact filename because the names are `@electron-forge` maker defaults that GitHub rewrites again on upload; pinning them would fail a good release the first time a default changed. Dropping a maker outright does fail the check, which is the intended alarm. Auto-release runs it as a final `verify` job that fires from the moment the tag exists, including when publishing was skipped — a tag with no release behind it is invisible to an install that auto-updates from release assets, and it is what happened to `v0.3.39`. The assertion is on assets present, never on an upstream exit code, because both release breaks on 2026-08-28 had green intermediate steps.

Never replace an asset or reuse a version after publication. If signing, notarization, Gatekeeper verification, or update compatibility fails, fix it and create a higher patch version. Keep the last known-good installer published. A future move away from `update.electronjs.org` can use the existing Squirrel-compatible static-feed support without changing the app's update interaction.

## Build on Windows

The Windows build host needs Python 3 and Visual Studio 2022 with **Desktop development with C++** and a Windows SDK. The focused native CI job and auto-release Windows build use `windows-2022` because the exact-SHA Electron `node-gyp` fork recognises Visual Studio only through 2022; the floating Windows image now carries Visual Studio 2026, which that ruled toolchain rejects. Desktop builds traverse to the adapter build and stage its complete native payload into the server bundle.

Windows development uses the normal Nx target:

```powershell
pnpm install --frozen-lockfile
pnpm nx run rennet-desktop:dev
```

Build the installer and portable ZIP with:

```powershell
pnpm nx run rennet-desktop:make
```

The build writes `Setup.exe`, a `.nupkg`, a `RELEASES` update manifest, and a win32 ZIP under `apps/desktop/out/make/`. MakerSquirrel runs only on Windows. MakerDMG runs only on macOS.

The Windows installer is unsigned and displays a SmartScreen warning on first launch. Windows code signing is planned in [issue #330](https://github.com/rbutera/rennet/issues/330).

The application uses `brand/exports/app-icons/windows/rennet-white-on-black.ico` for the executable and installer. Development loads that file at runtime because the development executable has no embedded Rennet icon.

Rennet does not require a POSIX login shell on Windows. Agent discovery checks the process environment and common Windows install locations. A project in WSL runs `git`, `gh`, `claude`, and `codex` inside its selected distribution through `wsl.exe`.

The Windows release package contains both `native/win32-x64/` for the host process and `native/linux-x64/` for the WSL daemon. Auto-release builds the Linux pair from the exact release commit before the Windows build and supplies it to Forge; a local Windows package must provide the same pair under `packages/adapters/dist/native/linux-x64/`. Forge rejects a completed Windows package unless its installed server tree contains exactly both platform directories. The Windows exclusive-move executable uses the native Windows move API. The Windows rooted-landing addon is deliberately loadable but its `RootedLandingHost` constructor reports that rooted landing is unsupported on Windows; macOS and Linux provide the rooted implementation. Inside WSL, delivery copies the whole server directory to `~/.rennet/server/<version>/`, sets `native/linux-x64/rennet-exclusive-move` to mode `0755`, and treats the version as complete only when `index.cjs`, the Linux rooted addon, and the executable Linux helper all pass their probes.

## Packaging configuration

[`forge.config.cjs`](forge.config.cjs) owns makers, icons, signing, notarization, Electron fuses, unpacked server assets, and package exclusions.

The packaged application keeps the daemon and browser bundles outside the asar because the detached daemon loads them from disk. It also copies tray assets into the application resources.

The adapter build writes one validated pair per collected platform under `packages/adapters/dist/native/<platform>-<arch>/`: `rennet-rooted-landing.node` and `rennet-exclusive-move` (`rennet-exclusive-move.exe` on Windows). The CLI build mirrors the complete native root to `packages/server/dist/native/` beside `rennet.cjs`; the desktop server build mirrors it to `apps/desktop/dist/server/native/`. Forge's existing server unpack rule places the latter at `Resources/app.asar.unpacked/dist/server/native/` in the installed macOS application. The bundled adapter resolves a `.cjs` caller's addon from that sibling `native/<platform>-<arch>/` directory.

The installed-package smoke calls both artifacts from that exact unpacked path. Runtime activation remains separate: `createRennetServer` still uses legacy source landing unless a `roundSourceLanding` injection is supplied, and `runDaemon` does not currently supply one. Shipping and installed-artifact execution are therefore proven here without claiming that production round landing has switched to the native path.

The Claude adapter uses the user's installed `claude` executable. Packaging excludes executables supplied inside `@anthropic-ai/claude-agent-sdk` so Rennet does not ship a second Claude binary.

## Automatic updates

Packaged builds check every five minutes through [`update-electron-app`](https://github.com/electron/update-electron-app). Development and test runs do not start the updater. This path uses GitHub or Electron update infrastructure and has no Rennet backend.

Rennet downloads an available update in the background. When the update is on disk, the logo menu and tray show the update-ready state. **Restart Rennet to update** applies it. `notifyUser: false` disables the library's restart dialog.

Windows reads Squirrel artifacts from the latest GitHub Release. It also checks for a newer staged `app-<version>` directory at startup and every five minutes, so a missed Electron event does not lose the ready state.

macOS uses `update.electronjs.org`, which derives its feed from non-draft, non-prerelease GitHub Releases. The updater starts only in a packaged application with a verified Developer ID signature. Development, tests, and ad hoc packages never contact the feed.
