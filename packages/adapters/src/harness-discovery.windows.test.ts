import { afterEach, describe, expect, it, vi } from "vitest";
import { type DiscoveryDeps, discoverClaude, type VersionRange } from "./harness-discovery";

const RANGE: VersionRange = { min: "2.0.0", maxTested: "2.1.220" };

function deps(over: Partial<DiscoveryDeps> & Pick<DiscoveryDeps, "platform">): DiscoveryDeps {
  return {
    loginShellPath: () => Promise.resolve(null),
    envPath: "",
    home: "C:\\Users\\rai",
    listDir: () => Promise.resolve([]),
    isExecutable: () => Promise.resolve(true),
    probeVersion: () => Promise.resolve(null),
    pathExt: ".COM;.EXE;.BAT;.CMD",
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("discoverClaude on Windows (windows-native-runtime)", () => {
  it("resolves a claude.cmd shim on a ;-delimited PATH and proves its version", async () => {
    const dir = "C:\\Users\\rai\\AppData\\Roaming\\npm";
    const result = await discoverClaude(
      deps({
        platform: "win32",
        envPath: `C:\\Windows\\System32;${dir}`,
        listDir: (d) => Promise.resolve(d === dir ? ["claude.cmd", "npm.cmd"] : []),
        isExecutable: (p) => Promise.resolve(p === `${dir}\\claude.cmd`),
        probeVersion: (p) => Promise.resolve(p === `${dir}\\claude.cmd` ? "2.1.100" : null),
      }),
      RANGE,
    );
    expect(result.chosen).toEqual({ path: `${dir}\\claude.cmd`, version: "2.1.100" });
    expect(result.health.state).toBe("ready");
    expect(result.candidates[0]?.locus).toEqual({ kind: "host" });
  });

  it("never harvests a POSIX shell on Windows (loginShellPath null) and still finds via a curated dir", async () => {
    // %APPDATA%\npm is a curated Windows location, checked even when off PATH.
    const appData = "C:\\Users\\rai\\AppData\\Roaming";
    const npmDir = `${appData}\\npm`;
    vi.stubEnv("APPDATA", appData);
    let harvested = false;
    const result = await discoverClaude(
      deps({
        platform: "win32",
        loginShellPath: () => {
          harvested = true;
          return Promise.resolve(null);
        },
        envPath: "C:\\Windows\\System32", // does NOT contain claude
        listDir: (d) => Promise.resolve(d === npmDir ? ["claude.exe"] : []),
        isExecutable: (p) => Promise.resolve(p === `${npmDir}\\claude.exe`),
        probeVersion: () => Promise.resolve("2.1.50"),
      }),
      RANGE,
    );
    // The default deps return null for loginShellPath on Windows; here we just prove
    // discovery does not DEPEND on a harvested PATH — the curated dir carries it.
    expect(harvested).toBe(true);
    expect(result.chosen?.path).toBe(`${npmDir}\\claude.exe`);
  });

  it("does not report a PowerShell script as directly executable", async () => {
    const dir = "C:\\tools";
    const result = await discoverClaude(
      deps({
        platform: "win32",
        envPath: dir,
        listDir: (candidate) => Promise.resolve(candidate === dir ? ["claude.ps1"] : []),
        probeVersion: () => Promise.resolve("2.1.100"),
      }),
      RANGE,
    );
    expect(result.chosen).toBeNull();
    expect(result.candidates).toEqual([]);
  });

  it("consumes the locus PATHEXT instead of a hard-coded suffix list", async () => {
    const dir = "C:\\tools";
    const result = await discoverClaude(
      deps({
        platform: "win32",
        pathExt: ".COM;.EXE",
        envPath: dir,
        listDir: (candidate) => Promise.resolve(candidate === dir ? ["claude.com"] : []),
        isExecutable: (path) => Promise.resolve(path === `${dir}\\claude.com`),
        probeVersion: () => Promise.resolve("2.1.100"),
      }),
      RANGE,
    );
    expect(result.chosen?.path).toBe(`${dir}\\claude.com`);
  });
});

describe("discoverClaude in a WSL distro (harness-discovery spec)", () => {
  const wsl = { kind: "wsl", distro: "Ubuntu" } as const;

  it("finds the in-distro claude and stamps the WSL locus", async () => {
    const bin = "/home/rai/.local/bin";
    const result = await discoverClaude(
      deps({
        platform: "linux",
        locus: wsl,
        home: "/home/rai",
        loginShellPath: () => Promise.resolve(`/usr/bin:${bin}`),
        listDir: (d) => Promise.resolve(d === bin ? ["claude"] : []),
        isExecutable: (p) => Promise.resolve(p === `${bin}/claude`),
        probeVersion: (p) => Promise.resolve(p === `${bin}/claude` ? "2.1.193" : null),
      }),
      RANGE,
    );
    expect(result.chosen).toEqual({ path: "/home/rai/.local/bin/claude", version: "2.1.193" });
    expect(result.candidates[0]?.locus).toEqual(wsl);
  });

  it("reports the WSL locus unavailable naming the distro when the distro claude is absent", async () => {
    // No claude anywhere in the distro — a host claude must NOT satisfy this (the
    // composition passes distro deps, which only ever see distro paths).
    const result = await discoverClaude(
      deps({
        platform: "linux",
        locus: wsl,
        home: "/home/rai",
        loginShellPath: () => Promise.resolve("/usr/bin:/bin"),
        listDir: () => Promise.resolve([]),
      }),
      RANGE,
    );
    expect(result.chosen).toBeNull();
    expect(result.health.state).toBe("unavailable");
    if (result.health.state === "unavailable") {
      expect(result.health.detail).toContain("Ubuntu");
    }
  });
});
