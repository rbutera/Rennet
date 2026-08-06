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
    osxSign: {
      identity: "-",
      identityValidation: false,
      optionsForFile: () => ({ hardenedRuntime: false }),
    },
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
