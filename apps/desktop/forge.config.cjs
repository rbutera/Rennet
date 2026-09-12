const { MakerDMG } = require("@electron-forge/maker-dmg");
const { MakerSquirrel } = require("@electron-forge/maker-squirrel");
const { MakerZIP } = require("@electron-forge/maker-zip");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { flipFuses, FuseV1Options, FuseVersion } = require("@electron/fuses");

// R2 packaging requirement: the Claude adapter depends on @anthropic-ai/claude-agent-sdk
// (now a production dependency of @rennet/adapters and @rennet/server, 0.3.223). Its
// per-platform package @anthropic-ai/claude-agent-sdk-<platform> carries a ~270 MB `claude`
// executable as its only real payload, and the main package can vendor its own CLI binary
// too. Rennet spawns the user's OWN installed binary via pathToClaudeCodeExecutable, so a
// bundled harness binary is never used, and CLAUDE.md forbids shipping one. Strip both
// shapes at package time. This mirrors T3 Code's DESKTOP_FILE_EXCLUSIONS precedent.
//
// NOTE these patterns are defence in depth: the blanket /^\/node_modules/ ignore below
// already keeps node_modules out of the bundle, so on that path they never fire. The
// load-bearing guard is the postPackage absence assertion (assertNoHarnessSdkPlatformArtifacts),
// which fails the build if a platform-package artifact reaches the packaged app by ANY route
// (a staged sidecar node_modules, a copied asset, a future change to the ignore list).
const HARNESS_SDK_FILE_EXCLUSIONS = [
  /\/node_modules\/@anthropic-ai\/claude-agent-sdk\/vendor\//,
  /\/node_modules\/@anthropic-ai\/claude-agent-sdk\/.*\/(?:cli|claude)(?:\.exe)?$/,
  // The per-platform packages: exclude each whole directory (its only real payload is the
  // vendored `claude` executable). The trailing hyphen keeps this from matching the main
  // @anthropic-ai/claude-agent-sdk package handled by the two patterns above.
  /\/node_modules\/@anthropic-ai\/claude-agent-sdk-[^/]+\//,
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

function packagedNativeRoot(outputPath, platform) {
  const resourcesRoot =
    platform === "darwin"
      ? path.join(outputPath, "Rennet.app", "Contents", "Resources")
      : path.join(outputPath, "resources");
  return path.join(resourcesRoot, "app.asar.unpacked", "dist", "server", "native");
}

async function verifyPackagedNativePayload(_forgeConfig, packageResult) {
  const { platform, arch, outputPaths } = packageResult;
  if (platform !== "darwin" && platform !== "win32") return;
  if (outputPaths.length === 0) throw new Error(`Forge produced no ${platform}-${arch} package`);

  // The T3 Code sidecar bundle (extraResource below) must be in every package: without
  // it the chat slot shows "sidecar unavailable", which no installed user may ever see.
  for (const outputPath of outputPaths) {
    const resourcesRoot =
      platform === "darwin"
        ? path.join(outputPath, "Rennet.app", "Contents", "Resources")
        : path.join(outputPath, "resources");
    const sidecarBin = path.join(resourcesRoot, "t3code", "apps", "server", "dist", "bin.mjs");
    if (!fs.existsSync(sidecarBin)) {
      throw new Error(`packaged app is missing the T3 Code sidecar bundle: ${sidecarBin}`);
    }
  }

  const checkerPath = path.join(__dirname, "../../scripts/check-native-artifact-layout.mjs");
  const { assertNativeArtifactLayout, assertNoHarnessSdkPlatformArtifacts } = await import(
    pathToFileURL(checkerPath).href
  );
  const expectedPlatforms =
    platform === "win32" ? [`win32-${arch}`, "linux-x64"] : [`darwin-${arch}`];
  for (const outputPath of outputPaths) {
    await assertNativeArtifactLayout(packagedNativeRoot(outputPath, platform), expectedPlatforms);
  }

  // A harness SDK per-platform `claude` binary must never ship (dead weight + a bundled
  // harness binary CLAUDE.md forbids). Fail the package if one reached the app by any route.
  for (const outputPath of outputPaths) {
    await assertNoHarnessSdkPlatformArtifacts(outputPath);
  }
}

// The app icon, per the platform the packaging RUNS on (add-windows-support). The
// path is given WITHOUT extension so @electron/packager appends `.icns` on macOS and
// `.ico` on Windows; the two brand exports live in separate dirs, so the base path is
// chosen here rather than relying on a single shared base. The COLOUR variant ships: a
// dock/taskbar tile is a colour surface, and the liquid sphere is the identity there.
// The monochrome variants stay in the brand pack for monochrome surfaces.
const appIcon =
  process.platform === "win32"
    ? path.join(__dirname, "../../brand/exports/app-icons/windows/rennet-color")
    : path.join(__dirname, "../../brand/exports/app-icons/macos/rennet-color");

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
    // Tray/menu-bar icons (tray-presence): the brand `tray/` dir lives at the repo root,
    // OUTSIDE this app package, so copy it into the packaged app's resources. The tray
    // module resolves `<process.resourcesPath>/tray` when packaged (the dev path reaches
    // brand/exports/tray directly). Unlike the app icon, the tray has no exe-embedded
    // fallback — it MUST ship these files.
    extraResource: [
      path.join(__dirname, "../../brand/exports/tray"),
      // The staged T3 Code sidecar (scripts/stage-t3-sidecar.mjs): the bundle, its
      // UPSTREAM.json and the native runtime externals, shipped at Resources/t3code so the
      // daemon can spawn it with no checkout present. Ignored from the asar below.
      path.join(__dirname, "dist/t3code"),
    ],
    ignore: [
      /^\/node_modules/,
      /^\/dist\/t3code/,
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
        setupIcon: path.join(__dirname, "../../brand/exports/app-icons/windows/rennet-color.ico"),
        iconUrl:
          "https://raw.githubusercontent.com/rbutera/rennet/main/brand/exports/app-icons/windows/rennet-color.ico",
      },
      ["win32"],
    ),
  ],
  publishers: [
    {
      name: "@electron-forge/publisher-github",
      config: {
        repository: { owner: "rbutera", name: "rennet" },
        draft: false,
        prerelease: false,
        generateReleaseNotes: true,
      },
    },
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
        // fuses (OnlyLoadAppFromAsar, etc.) stay locked down.
        [FuseV1Options.RunAsNode]: true,
        // macOS cookie encryption opens Keychain even without safeStorage calls. Auth is
        // daemon/bearer-owned; main archives the old cookie store before opening a session.
        [FuseV1Options.EnableCookieEncryption]: platform !== "darwin",
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
        [FuseV1Options.EnableNodeCliInspectArguments]: false,
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
        [FuseV1Options.OnlyLoadAppFromAsar]: true,
        [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
        [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
        [FuseV1Options.WasmTrapHandlers]: true,
      });
    },
    postPackage: verifyPackagedNativePayload,
  },
};
