import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

// forge.config.cjs computes its signing config from process.env at load time, so
// each case clears the four Apple vars, sets the ones under test, and re-requires
// the module fresh. These assertions guard the honesty invariants a bad signing
// build would violate: the real-signing path must be FATAL-on-failure, and the
// notarize block must only appear when all creds are present.
const require = createRequire(import.meta.url);
const configPath = require.resolve("../../forge.config.cjs");
const APPLE_VARS = [
  "APPLE_SIGNING_IDENTITY",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
] as const;

const savedEnv = new Map(APPLE_VARS.map((key) => [key, process.env[key]]));

type ForgeConfig = {
  packagerConfig: {
    icon: string;
    extraResource: string[];
    ignore: RegExp[];
    osxSign: {
      identity: string;
      continueOnError?: boolean;
      optionsForFile: () => { hardenedRuntime: boolean; entitlements?: string };
    };
    osxNotarize?: { appleId: string; appleIdPassword: string; teamId: string };
  };
  makers: { platforms?: string[] | null }[];
  publishers: Array<{
    name: string;
    config: {
      repository: { owner: string; name: string };
      draft: boolean;
      prerelease: boolean;
    };
  }>;
};

function loadConfig(env: Partial<Record<(typeof APPLE_VARS)[number], string>>): ForgeConfig {
  for (const key of APPLE_VARS) delete process.env[key];
  Object.assign(process.env, env);
  delete require.cache[configPath];
  return require(configPath) as ForgeConfig;
}

afterEach(() => {
  for (const key of APPLE_VARS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete require.cache[configPath];
});

describe("forge.config.cjs signing", () => {
  it("packages the white-on-black brand icon for the packaging platform", () => {
    const { packagerConfig } = loadConfig({});
    // The product picks the icon by `process.platform` (win32 → the `.ico` export dir,
    // else the macOS `.icns` dir). Key the expectation the same way so this asserts the
    // real per-platform choice — on Windows it becomes live win32 icon coverage.
    const expected =
      process.platform === "win32"
        ? /brand[\\/]exports[\\/]app-icons[\\/]windows[\\/]rennet-white-on-black$/
        : /brand[\\/]exports[\\/]app-icons[\\/]macos[\\/]rennet-white-on-black$/;
    expect(packagerConfig.icon).toMatch(expected);
  });

  it("bundles the tray icons as a resource (they have no exe-embedded fallback)", () => {
    const { packagerConfig } = loadConfig({});
    expect(packagerConfig.extraResource).toEqual([
      expect.stringMatching(/brand[\\/]exports[\\/]tray$/),
    ]);
  });

  it("default (no creds): ad-hoc signature, not hardened, no notarization", () => {
    const { packagerConfig } = loadConfig({});
    expect(packagerConfig.osxSign.identity).toBe("-");
    expect(packagerConfig.osxSign.optionsForFile().hardenedRuntime).toBe(false);
    expect("osxNotarize" in packagerConfig).toBe(false);
  });

  it("real-signing path makes a signing failure FATAL (continueOnError:false)", () => {
    const { packagerConfig } = loadConfig({
      APPLE_SIGNING_IDENTITY: "Developer ID Application: Test (ABCDE12345)",
    });
    expect(packagerConfig.osxSign.identity).toBe("Developer ID Application: Test (ABCDE12345)");
    // The regression guard: @electron/packager defaults osxSign.continueOnError
    // to true, which would ship an unsigned app under a 0 exit code.
    expect(packagerConfig.osxSign.continueOnError).toBe(false);
    const perFile = packagerConfig.osxSign.optionsForFile();
    expect(perFile.hardenedRuntime).toBe(true);
    expect(perFile.entitlements).toMatch(/entitlements\.plist$/);
  });

  it("signing identity alone does not enable notarization", () => {
    const { packagerConfig } = loadConfig({
      APPLE_SIGNING_IDENTITY: "Developer ID Application: Test (ABCDE12345)",
    });
    expect("osxNotarize" in packagerConfig).toBe(false);
  });

  it("ships an unsigned win32 ZIP maker (add-windows-support)", () => {
    const { makers } = loadConfig({});
    const win32Makers = makers.filter((maker) => maker.platforms?.includes("win32"));
    expect(win32Makers.length).toBeGreaterThanOrEqual(1);
  });

  it("the harness-SDK exclusion strips a vendored .exe (Windows) as well as a bare cli", () => {
    const { packagerConfig } = loadConfig({});
    const matches = (p: string) => packagerConfig.ignore.some((re) => re.test(p));
    expect(matches("/app/node_modules/@anthropic-ai/claude-agent-sdk/cli/cli.exe")).toBe(true);
    expect(matches("/app/node_modules/@anthropic-ai/claude-agent-sdk/vendor/claude")).toBe(true);
    // An ordinary app file is NOT excluded.
    expect(matches("/app/node_modules/@rennet/adapters/dist/index.js")).toBe(false);
  });

  it("all four creds enable notarytool notarization", () => {
    const { packagerConfig } = loadConfig({
      APPLE_SIGNING_IDENTITY: "Developer ID Application: Test (ABCDE12345)",
      APPLE_ID: "dev@example.com",
      APPLE_APP_SPECIFIC_PASSWORD: "aaaa-bbbb-cccc-dddd",
      APPLE_TEAM_ID: "ABCDE12345",
    });
    expect(packagerConfig.osxNotarize).toEqual({
      appleId: "dev@example.com",
      appleIdPassword: "aaaa-bbbb-cccc-dddd",
      teamId: "ABCDE12345",
    });
  });

  it("publishes only draft releases to the public Rennet repository", () => {
    const { publishers } = loadConfig({});
    expect(publishers).toEqual([
      expect.objectContaining({
        name: "@electron-forge/publisher-github",
        config: expect.objectContaining({
          repository: { owner: "rbutera", name: "rennet" },
          draft: true,
          prerelease: false,
        }),
      }),
    ]);
  });
});
