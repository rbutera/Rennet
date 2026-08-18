const { MakerDMG } = require("@electron-forge/maker-dmg");
const { MakerSquirrel } = require("@electron-forge/maker-squirrel");
const { MakerZIP } = require("@electron-forge/maker-zip");
const path = require("node:path");
const { flipFuses, FuseV1Options, FuseVersion } = require("@electron/fuses");

// R2 packaging requirement: the Claude adapter uses @anthropic-ai/claude-agent-sdk,
// which vendors a per-platform `claude` executable (~270 MB). Rennet spawns the
// user's OWN installed binary via pathToClaudeCodeExecutable, so the SDK's bundled
// executables must be stripped at package time. This mirrors T3 Code's
// DESKTOP_FILE_EXCLUSIONS precedent. The SDK is not yet a production dependency
// (its licence is not in the MIT-family gate and it fails the release-age policy;
// see the follow-up bead), so this rule is dormant today and recorded ahead of
// packaging so a future dependency addition cannot silently ship the binaries.
const HARNESS_SDK_FILE_EXCLUSIONS = [
  /\/node_modules\/@anthropic-ai\/claude-agent-sdk\/vendor\//,
  /\/node_modules\/@anthropic-ai\/claude-agent-sdk\/.*\/(?:cli|claude)(?:\.exe)?$/,
];

// Signing is CONDITIONAL on the presence of an Apple Developer ID identity in the
// environment. See apps/desktop/PACKAGING.md for the one-step Rai runs.
//
// - No APPLE_SIGNING_IDENTITY  -> ad-hoc signature (identity "-"), no hardened
//   runtime, no notarization. The DMG builds and the app launches, but Gatekeeper
//   shows the usual "unidentified developer" warning. This is the default and needs
//   no Apple account.
// - APPLE_SIGNING_IDENTITY set  -> real Developer ID Application signature with the
//   hardened runtime + entitlements (both REQUIRED for notarization).
// - ...and APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID also set ->
//   the same `make` additionally notarizes and staples via notarytool.
const signingIdentity = process.env.APPLE_SIGNING_IDENTITY?.trim();
const entitlementsPath = path.join(__dirname, "entitlements.plist");

const osxSign = signingIdentity
  ? {
      identity: signingIdentity,
      // Make a real-signing failure FATAL. @electron/packager defaults osxSign to
      // `continueOnError: true` (mac.js createSignOpts), which swallows a failed
      // Developer ID sign as a warning and ships an ad-hoc / unsigned app that
      // exits 0 — a build that claims it is signed while it is not. On the real
      // signing path we want the opposite: fail loud so a broken/absent cert
      // stops the release instead of producing a bad artifact. (The default
      // ad-hoc branch keeps the permissive default; "-" signing does not fail.)
      continueOnError: false,
      optionsForFile: () => ({
        hardenedRuntime: true,
        entitlements: entitlementsPath,
      }),
    }
  : {
      identity: "-",
      identityValidation: false,
      optionsForFile: () => ({ hardenedRuntime: false }),
    };

const canNotarize =
  Boolean(signingIdentity) &&
  Boolean(process.env.APPLE_ID) &&
  Boolean(process.env.APPLE_APP_SPECIFIC_PASSWORD) &&
  Boolean(process.env.APPLE_TEAM_ID);

const osxNotarize = canNotarize
  ? {
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    }
  : undefined;

// The app icon, per the platform the packaging RUNS on (add-windows-support). The
// path is given WITHOUT extension so @electron/packager appends `.icns` on macOS and
// `.ico` on Windows; the two brand exports live in separate dirs, so the base path is
// chosen here rather than relying on a single shared base.
const appIcon =
  process.platform === "win32"
    ? path.join(__dirname, "../../brand/exports/app-icons/windows/rennet-white-on-black")
    : path.join(__dirname, "../../brand/exports/app-icons/macos/rennet-white-on-black");

module.exports = {
  packagerConfig: {
    // The detached daemon (#379) is spawned as a plain Node process (ELECTRON_RUN_AS_NODE),
    // so its bundle must live on disk OUTSIDE the asar for a Node `require` to load it.
    // Un-asar the whole server build dir; everything else stays packed. The browser UI
    // (#381) joins it: the daemon serves those files with `createReadStream`, which reads a
    // real on-disk path, so `dist/browser` must be unpacked beside `dist/server`.
    // NOTE: electron-packager takes this as `asar.unpack` (one minimatch glob) — the
    // electron-builder-style `asarUnpack` array is silently ignored (v0.1.10's macOS
    // smoke failure: daemon.json never appeared because the bundle stayed inside the asar).
    asar: { unpack: "**/dist/@(server|browser)/**" },
    executableName: "Rennet",
    icon: appIcon,
    ignore: [
      /^\/node_modules/,
      /^\/src/,
      /^\/e2e/,
      /^\/test-results/,
      ...HARNESS_SDK_FILE_EXCLUSIONS,
    ],
    name: "Rennet",
    osxSign,
    ...(osxNotarize ? { osxNotarize } : {}),
    prune: false,
  },
  // win32 ships BOTH a Squirrel installer (Setup.exe + .nupkg + RELEASES — the
  // auto-update feed update.electronjs.org serves) and the plain ZIP (portable, no
  // installer). MakerSquirrel only runs its build on Windows, so a local macOS `make`
  // simply skips it and still produces the darwin ZIP/DMG; CI on windows produces the
  // Squirrel artifacts. iconUrl points at the brand `.ico` in the public repo (Squirrel
  // fetches it for the Add/Remove Programs entry); setupIcon is the local `.ico` baked
  // into Setup.exe, resolved with the same lazy base as the app icon above.
  makers: [
    new MakerZIP({}, ["darwin"]),
    new MakerDMG({}, ["darwin"]),
    new MakerZIP({}, ["win32"]),
    new MakerSquirrel(
      {
        name: "Rennet",
        authors: "Rai Butera",
        setupIcon: path.join(
          __dirname,
          "../../brand/exports/app-icons/windows/rennet-white-on-black.ico",
        ),
        iconUrl:
          "https://raw.githubusercontent.com/rbutera/rennet/main/brand/exports/app-icons/windows/rennet-white-on-black.ico",
      },
      ["win32"],
    ),
  ],
  hooks: {
    packageAfterExtract: async (_forgeConfig, buildPath, _electronVersion, platform) => {
      const electronPath =
        platform === "darwin"
          ? path.join(buildPath, "Electron.app")
          : path.join(buildPath, platform === "win32" ? "electron.exe" : "electron");
      await flipFuses(electronPath, {
        version: FuseVersion.V1,
        // RunAsNode is ENABLED (#379, design D4): the detached daemon runs the Electron
        // binary as Node via ELECTRON_RUN_AS_NODE, which this fuse gates. The daemon IS the
        // product's capability — Rule Zero forbids trading it away for hardening. The other
        // fuses (OnlyLoadAppFromAsar, cookie encryption, etc.) stay locked down.
        [FuseV1Options.RunAsNode]: true,
        [FuseV1Options.EnableCookieEncryption]: true,
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
        [FuseV1Options.EnableNodeCliInspectArguments]: false,
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
        [FuseV1Options.OnlyLoadAppFromAsar]: true,
        [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
        [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
        [FuseV1Options.WasmTrapHandlers]: true,
      });
    },
  },
};
