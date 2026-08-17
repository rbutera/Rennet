# Packaging the Rennet desktop app

Rennet's primary build is a macOS `.dmg`; on Windows CI it also builds a **Squirrel
installer** (which drives auto-update) alongside a portable unsigned **win32 ZIP**
(see the Windows and Auto-update sections at the end). The macOS part below covers the
two builds: the **default unsigned build** (works with no Apple account) and the
**signed + notarized build** (one step, Rai runs it when releasing). The signing,
notarization, and DMG steps are macOS-only.

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

The SAME `make` command produces a release build whose **`Rennet.app` is signed
with your Developer ID, notarized, and stapled** the moment the Apple credentials
are present in the environment. Nothing else changes.

**What actually gets processed:** electron-forge signs, notarizes, and staples the
**app** during packaging, *before* MakerDMG wraps it. The `.dmg` file itself is
only a container — it is **not** separately signed, notarized, or stapled. So
verify against the app (mounted from the DMG, or installed), never against the
`.dmg`. Because the app carries its own stapled notarization ticket, it launches
with no Gatekeeper warning once copied to /Applications. (Notarizing the `.dmg`
*itself* — so the download passes Gatekeeper before it is even opened — is a
separate `xcrun notarytool submit` + `xcrun stapler staple` on the `.dmg`. That
is not wired here and is not needed for the installed app to run clean.)

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

That is the whole step. The `Rennet.app` inside the resulting DMG is signed,
notarized, and stapled, so it opens with no Gatekeeper warning on any Mac once
copied out of the DMG.

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

Mount the DMG and verify the **app inside it** (not the `.dmg`):

```bash
DMG=$(ls apps/desktop/out/make/*.dmg | head -1)
MP=$(hdiutil attach "$DMG" -nobrowse -readonly | grep /Volumes | awk -F'\t' '{print $NF}')
APP="$MP"/Rennet.app
codesign --verify --deep --strict --verbose=2 "$APP"   # -> valid on disk
xcrun stapler validate "$APP"                          # -> The validate action worked!
spctl -a -vvv -t exec "$APP"                           # -> accepted (source=Notarized Developer ID)
hdiutil detach "$MP"
```

`-t exec` is the Gatekeeper assessment type for an application (`-t install` is
for installer packages, not this app). On the default unsigned build, `codesign`
still reports the ad-hoc signature as valid, but `stapler validate` fails (no
notarization ticket) and `spctl -a -t exec` reports `rejected` — that is the
Gatekeeper warning described above, and it is the only difference.

## How the config is wired

`apps/desktop/forge.config.cjs` reads the four env vars and builds `osxSign` /
`osxNotarize` conditionally, so no certificate or secret is ever hardcoded. See
the comments at the top of that file. The hardened-runtime entitlements live in
`apps/desktop/entitlements.plist` and are applied only on the signed path.

## Windows (win32) — unsigned ZIP

Rennet also runs on Windows, natively and driving a WSL distro (see the Windows +
WSL install guide under `docs/` → Using Rennet → Getting started). Windows CI now
builds **both** a Squirrel installer (`Setup.exe`, the `.nupkg`, and the `RELEASES`
manifest — the feed auto-update reads) and the portable unsigned ZIP. **Windows code
signing is still a separate slice** (the counterpart of the macOS Developer ID work);
the Squirrel build is currently unsigned, which is enough for install and auto-update
but shows the SmartScreen "unknown publisher" prompt on first run.

Every step above from the "signed + notarized" build onward is **macOS-only**: the
Apple env vars, `osxSign`/`osxNotarize`, `codesign`/`stapler`/`spctl`, the DMG
maker's native addons (`macos-alias`, `fs-xattr`), and the `hdiutil` shell snippets
(zsh/bash) do not apply on Windows and are not required there.

### Dev run

```powershell
pnpm install
pnpm exec nx run rennet-desktop:start
```

The `start` target builds with Vite and launches Electron — the same
cross-platform targets used on macOS. The dev run has no exe-embedded icon, so the
window loads the brand `.ico` from `brand/exports/app-icons/windows/` directly and
sets a stable taskbar identity (`com.rennet.desktop`); if the brand file is missing
it falls back to Electron's default icon rather than failing. There is **no POSIX
login shell on Windows**:
harness discovery uses the process environment plus curated Windows install
locations (`%APPDATA%\npm`, `%LOCALAPPDATA%\Programs`, scoop/bun/volta), so no
`zsh`/`bash` is needed. For a WSL-locus project, `git`/`gh`/`claude`/`codex` run
inside the distro via `wsl.exe ... -e`; only WSL itself is required on the host.

### Build the ZIP

```powershell
pnpm exec nx run rennet-desktop:package
pnpm exec nx run rennet-desktop:make
```

`forge.config.cjs` adds `new MakerZIP({}, ["win32"])` **and** `new MakerSquirrel({…},
["win32"])`, and selects the Windows `.ico`
(`brand/exports/app-icons/windows/rennet-white-on-black.ico`) when packaging runs on
Windows. `MakerSquirrel` only runs its build on Windows, so a local macOS `make` skips
it and still produces the darwin ZIP/DMG. The Electron fuses hook already flips
`electron.exe`, and the harness-SDK vendored-executable exclusion strips a bundled
`claude.exe` the same way it strips the macOS `cli`.

## Auto-update

Rennet updates itself with the Electron-maintained
[`update-electron-app`](https://github.com/electron/update-electron-app) client,
pointed at the free public **update.electronjs.org** service. That service resolves
this repo's public **GitHub Releases** and serves the newest build; there is **no
Rennet backend** in the loop. The update client is wired in
`apps/desktop/src/main/auto-update.ts` and started from `whenReady` **only when
`app.isPackaged`** (a dev or test run has no release to pull).

**Egress disclosure (honest copy, not a consent screen):** on a packaged build the
app periodically pings `update.electronjs.org` with its **name, version, and
platform** to ask whether a newer release exists. That is the only traffic the
updater generates, and it fires on packaged builds automatically — there is no toggle
and no dialog to clear. When a newer build is found it downloads in the background and
`update-electron-app` shows its default "restart to apply" prompt; that prompt is the
product telling you an update is ready, not a gate.

**Per platform:**

- **Windows** — works as soon as Squirrel artifacts (`Setup.exe`, `.nupkg`,
  `RELEASES`) ship in a GitHub Release, which the `MakerSquirrel` maker now produces
  on Windows CI. Squirrel handles install/update shortcut events; the app quits early
  for those via `electron-squirrel-startup` and aligns its taskbar/toast AUMID to the
  `com.squirrel.Rennet.Rennet` id Squirrel stamps on the shortcut.
- **macOS** — Squirrel.Mac **requires a real code-signed app**. Until releases are
  Developer-ID-signed (issue #42) the updater has nothing valid to apply, so it
  **degrades to a silent no-op**: `auto-update.ts` wraps the call in try/catch and
  attaches a quiet `autoUpdater` "error" listener, so an unsigned/ad-hoc build never
  crashes or nags. Once signed macOS releases ship, updates activate with no code
  change.
