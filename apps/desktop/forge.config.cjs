const { MakerDMG } = require("@electron-forge/maker-dmg");
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

module.exports = {
  packagerConfig: {
    asar: true,
    executableName: "Rennet",
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
  makers: [new MakerZIP({}, ["darwin"]), new MakerDMG({}, ["darwin"])],
  hooks: {
    packageAfterExtract: async (_forgeConfig, buildPath, _electronVersion, platform) => {
      const electronPath =
        platform === "darwin"
          ? path.join(buildPath, "Electron.app")
          : path.join(buildPath, platform === "win32" ? "electron.exe" : "electron");
      await flipFuses(electronPath, {
        version: FuseVersion.V1,
        [FuseV1Options.RunAsNode]: false,
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
