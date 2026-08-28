# Package the Rennet desktop app

Electron Forge builds Rennet for macOS and Windows. macOS builds produce a DMG and ZIP. Windows builds produce a Squirrel installer, update feed, and portable ZIP.

Both release workflows produce Developer ID signed, notarized, and stapled macOS artifacts. Windows artifacts remain unsigned until issue #330.

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

Never replace an asset or reuse a version after publication. If signing, notarization, Gatekeeper verification, or update compatibility fails, fix it and create a higher patch version. Keep the last known-good installer published. A future move away from `update.electronjs.org` can use the existing Squirrel-compatible static-feed support without changing the app's update interaction.

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

macOS uses `update.electronjs.org`, which derives its feed from non-draft, non-prerelease GitHub Releases. The updater starts only in a packaged application with a verified Developer ID signature. Development, tests, and ad hoc packages never contact the feed.
