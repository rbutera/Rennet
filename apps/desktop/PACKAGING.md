# Packaging the Rennet desktop app (macOS)

Rennet ships as a macOS `.dmg`. This doc covers the two builds: the **default
unsigned build** (works with no Apple account) and the **signed + notarized
build** (one step, Rai runs it when releasing).

## Prerequisites

- macOS on Apple Silicon (the makers target `darwin/arm64`).
- Xcode Command Line Tools (`xcode-select --install`) — needed to compile the two
  native node-gyp addons the DMG maker uses (`macos-alias`, `fs-xattr`). `pnpm
  install` builds them automatically because they are listed under
  `onlyBuiltDependencies` in `pnpm-workspace.yaml`.

## Build a DMG

```bash
pnpm install                       # once; compiles the DMG maker's native addons
pnpm exec nx run rennet-desktop:make
```

Artifacts land in `apps/desktop/out/make/`:

- `Rennet-<version>-arm64.dmg` — the installer (drag Rennet.app to Applications).
- `zip/darwin/arm64/Rennet-darwin-arm64-<version>.zip` — the same app, zipped.

To sanity-check the packaged app boots (signature + fuse policy + a launch smoke):

```bash
pnpm exec nx run rennet-desktop:package-smoke
```

### Default (unsigned) build

With no Apple credentials in the environment, `make` produces an **ad-hoc signed**
DMG. It builds and launches, but macOS Gatekeeper shows the usual
"unidentified developer" / "cannot be opened" warning; the user right-clicks →
Open (or clears it in System Settings → Privacy & Security). This is expected and
fine for local/dev distribution — no Apple account required.

## Signed + notarized build (release)

The SAME `make` command produces a signed, notarized, stapled DMG the moment the
Apple credentials are present in the environment. Nothing else changes.

### The one thing Rai does

1. Install the **Developer ID Application** certificate in the login keychain
   (from developer.apple.com, or Xcode → Settings → Accounts → Manage
   Certificates → +). Confirm it is present:

   ```bash
   security find-identity -v -p codesigning
   # look for:  "Developer ID Application: <Name> (<TEAMID>)"
   ```

2. Create an **app-specific password** for the Apple ID at
   <https://appleid.apple.com> → Sign-In and Security → App-Specific Passwords.

3. Set four environment variables, then run `make`:

   ```bash
   export APPLE_SIGNING_IDENTITY="Developer ID Application: <Name> (<TEAMID>)"
   export APPLE_ID="<apple-id-email>"
   export APPLE_APP_SPECIFIC_PASSWORD="<app-specific-password>"
   export APPLE_TEAM_ID="<TEAMID>"

   pnpm exec nx run rennet-desktop:make
   ```

That is the whole step. The resulting DMG passes `spctl -a -t open --context
context:primary-signature` and opens with no Gatekeeper warning on any Mac.

### What each variable controls

| Variable | Purpose | Used for |
|---|---|---|
| `APPLE_SIGNING_IDENTITY` | The Developer ID Application identity string. **Its presence alone flips the build from ad-hoc to signed** (hardened runtime + `entitlements.plist`). | Code signing |
| `APPLE_ID` | Apple ID email. | Notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password (NOT the Apple ID password). | Notarization |
| `APPLE_TEAM_ID` | 10-character Team ID. | Notarization |

Notarization runs only when **all four** are set. If only
`APPLE_SIGNING_IDENTITY` is set, the app is signed with the real identity but not
notarized (useful for testing signing without a notarization round-trip).

### Verifying a signed build

```bash
DMG=$(ls apps/desktop/out/make/*.dmg | head -1)
MP=$(hdiutil attach "$DMG" -nobrowse -readonly | grep /Volumes | awk -F'\t' '{print $NF}')
codesign --verify --deep --strict --verbose=2 "$MP"/*.app     # -> valid on disk
spctl -a -vvv -t install "$MP"/*.app                          # -> accepted (source=Notarized Developer ID)
hdiutil detach "$MP"
```

On the default unsigned build, that `spctl` assessment reports `rejected` — that
is the Gatekeeper warning described above, and it is the only difference.

## How the config is wired

`apps/desktop/forge.config.cjs` reads the four env vars and builds `osxSign` /
`osxNotarize` conditionally, so no certificate or secret is ever hardcoded. See
the comments at the top of that file. The hardened-runtime entitlements live in
`apps/desktop/entitlements.plist` and are applied only on the signed path.
