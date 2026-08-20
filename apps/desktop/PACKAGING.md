# Package the Rennet desktop app

Electron Forge builds Rennet for macOS and Windows. macOS builds produce a DMG and ZIP. Windows builds produce a Squirrel installer, update feed, and portable ZIP.

The automatic release workflow publishes unsigned artifacts. The Forge configuration can also sign and notarize a macOS application when the required Apple credentials are present.

## Prerequisites

The macOS build requires:

- Apple Silicon macOS
- Xcode Command Line Tools
- The repository dependencies installed with `pnpm install --frozen-lockfile`

The DMG maker uses `macos-alias` and `fs-xattr`. The workspace lists both native packages under `onlyBuiltDependencies`, so pnpm builds them during installation.

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

### Unsigned builds

Without Apple credentials, Forge applies an ad hoc signature. The application runs, but Gatekeeper identifies it as coming from an unknown developer. Open it once through the Finder context menu or approve it in System Settings under Privacy & Security.

### Developer ID builds

Set these variables before running the same `make` target:

```sh
export APPLE_SIGNING_IDENTITY="Developer ID Application: <Name> (<TEAMID>)"
export APPLE_ID="<apple-id-email>"
export APPLE_APP_SPECIFIC_PASSWORD="<app-specific-password>"
export APPLE_TEAM_ID="<TEAMID>"

pnpm nx run rennet-desktop:make
```

`APPLE_SIGNING_IDENTITY` selects Developer ID signing, hardened runtime, and `apps/desktop/entitlements.plist`. When all four variables are present, Forge also notarizes and staples `Rennet.app`. If only the identity is present, Forge signs the application but does not notarize it.

Forge processes the application before MakerDMG wraps it. The DMG itself is not separately signed, notarized, or stapled.

Create the application-specific password at [appleid.apple.com](https://appleid.apple.com). Confirm the Developer ID Application certificate is in the login keychain with:

```sh
security find-identity -v -p codesigning
```

### Verify a Developer ID build

Mount the DMG and run the checks against `Rennet.app`:

```sh
DMG=$(ls apps/desktop/out/make/*.dmg | head -1)
MP=$(hdiutil attach "$DMG" -nobrowse -readonly | grep /Volumes | awk -F'\t' '{print $NF}')
APP="$MP"/Rennet.app
codesign --verify --deep --strict --verbose=2 "$APP"
xcrun stapler validate "$APP"
spctl -a -vvv -t exec "$APP"
hdiutil detach "$MP"
```

For a valid notarized build, `codesign` reports `valid on disk`, `stapler` reports a valid ticket, and `spctl` reports `accepted` with `Notarized Developer ID` as the source. An ad hoc build passes the `codesign` check but fails the notarization and Gatekeeper checks.

## Build on Windows

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

## Packaging configuration

[`forge.config.cjs`](forge.config.cjs) owns makers, icons, signing, notarization, Electron fuses, unpacked server assets, and package exclusions.

The packaged application keeps the daemon and browser bundles outside the asar because the detached daemon loads them from disk. It also copies tray assets into the application resources.

The Claude adapter uses the user's installed `claude` executable. Packaging excludes executables supplied inside `@anthropic-ai/claude-agent-sdk` so Rennet does not ship a second Claude binary.

## Automatic updates

Packaged builds check every five minutes through [`update-electron-app`](https://github.com/electron/update-electron-app). Development and test runs do not start the updater. This path uses GitHub or Electron update infrastructure and has no Rennet backend.

Rennet downloads an available update in the background. When the update is on disk, the logo menu and tray show the update-ready state. **Restart Rennet to update** applies it. `notifyUser: false` disables the library's restart dialog.

Windows reads Squirrel artifacts from the latest GitHub Release. It also checks for a newer staged `app-<version>` directory at startup and every five minutes, so a missed Electron event does not lose the ready state.

macOS uses `update.electronjs.org`, which derives its feed from GitHub Releases. Squirrel.Mac requires a Developer ID signed application. Ad hoc builds record updater errors and continue without showing an update-ready state. Public Developer ID signed macOS releases are planned in [issue #298](https://github.com/rbutera/rennet/issues/298).
