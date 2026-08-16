import { describe, expect, it } from "vitest";
import {
  detectLocus,
  HOST_LOCUS,
  type Locus,
  locusCommand,
  toDistroPath,
  toWindowsView,
  WSL_EXE,
} from "./locus";

describe("detectLocus", () => {
  it("detects a \\\\wsl.localhost project as its named distro", () => {
    expect(detectLocus("\\\\wsl.localhost\\Ubuntu\\home\\rai\\repo")).toEqual({
      kind: "wsl",
      distro: "Ubuntu",
    });
  });

  it("detects the legacy \\\\wsl$ alias", () => {
    expect(detectLocus("\\\\wsl$\\Debian\\home\\u\\p")).toEqual({ kind: "wsl", distro: "Debian" });
  });

  it("is case-insensitive on the UNC host part", () => {
    expect(detectLocus("\\\\WSL.LOCALHOST\\Ubuntu\\home")).toEqual({
      kind: "wsl",
      distro: "Ubuntu",
    });
  });

  it("treats a drive-letter path as host", () => {
    expect(detectLocus("C:\\dev\\repo")).toBe(HOST_LOCUS);
  });

  it("treats a POSIX path as host (macOS/Linux)", () => {
    expect(detectLocus("/Users/rai/dev/repo")).toBe(HOST_LOCUS);
  });
});

describe("toDistroPath", () => {
  it("maps a UNC path to distro-native", () => {
    expect(toDistroPath("\\\\wsl.localhost\\Ubuntu\\home\\rai\\repo")).toBe("/home/rai/repo");
  });

  it("maps the \\\\wsl$ alias too", () => {
    expect(toDistroPath("\\\\wsl$\\Ubuntu\\home\\rai\\repo")).toBe("/home/rai/repo");
  });

  it("preserves spaces and non-ASCII", () => {
    expect(toDistroPath("\\\\wsl.localhost\\Ubuntu\\home\\rai\\my repo\\café")).toBe(
      "/home/rai/my repo/café",
    );
  });

  it("returns an already distro-native path unchanged", () => {
    expect(toDistroPath("/home/rai/repo")).toBe("/home/rai/repo");
  });

  it("returns null for a drive-letter path", () => {
    expect(toDistroPath("C:\\dev\\repo")).toBeNull();
  });

  it("maps the distro root", () => {
    expect(toDistroPath("\\\\wsl.localhost\\Ubuntu")).toBe("/");
  });
});

describe("toWindowsView", () => {
  it("round-trips with toDistroPath", () => {
    const unc = toWindowsView("/home/rai/repo", "Ubuntu");
    expect(unc).toBe("\\\\wsl.localhost\\Ubuntu\\home\\rai\\repo");
    expect(toDistroPath(unc)).toBe("/home/rai/repo");
  });

  it("preserves spaces round-trip", () => {
    const unc = toWindowsView("/home/rai/my repo", "Ubuntu");
    expect(toDistroPath(unc)).toBe("/home/rai/my repo");
  });
});

describe("locusCommand", () => {
  it("passes a host command through unchanged", () => {
    expect(locusCommand(HOST_LOCUS, "git", ["status"], "/repo")).toEqual({
      file: "git",
      args: ["status"],
      cwd: "/repo",
    });
  });

  it("omits cwd when none is given (host)", () => {
    expect(locusCommand(HOST_LOCUS, "git", ["--version"])).toEqual({
      file: "git",
      args: ["--version"],
    });
  });

  it("builds the -e/--exec form for a WSL locus, translating the cwd", () => {
    const wsl: Locus = { kind: "wsl", distro: "Ubuntu" };
    expect(
      locusCommand(wsl, "git", ["status"], "\\\\wsl.localhost\\Ubuntu\\home\\rai\\repo"),
    ).toEqual({
      file: WSL_EXE,
      args: ["-d", "Ubuntu", "--cd", "/home/rai/repo", "-e", "git", "status"],
    });
  });

  it("never uses the -- shell form (argv stays verbatim: backslashes, $, quotes)", () => {
    const wsl: Locus = { kind: "wsl", distro: "Ubuntu" };
    const cmd = locusCommand(wsl, "git", ["commit", "-m", "it's a $HOME C:\\x test"], "/home/u/r");
    expect(cmd.args).not.toContain("--");
    expect(cmd.args).toContain("-e");
    // The message arg survives byte-for-byte as a discrete argv element.
    expect(cmd.args).toContain("it's a $HOME C:\\x test");
  });

  it("uses an already-distro-native cwd as-is", () => {
    const wsl: Locus = { kind: "wsl", distro: "Ubuntu" };
    expect(locusCommand(wsl, "gh", ["pr", "create"], "/home/rai/repo").args).toEqual([
      "-d",
      "Ubuntu",
      "--cd",
      "/home/rai/repo",
      "-e",
      "gh",
      "pr",
      "create",
    ]);
  });

  it("omits --cd when no cwd is given (WSL)", () => {
    const wsl: Locus = { kind: "wsl", distro: "Ubuntu" };
    expect(locusCommand(wsl, "claude", ["--version"]).args).toEqual([
      "-d",
      "Ubuntu",
      "-e",
      "claude",
      "--version",
    ]);
  });
});
