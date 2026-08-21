import { afterEach, describe, expect, it } from "vitest";
import { listWslDistros, parseWslDistroList } from "./wsl-distros";

describe("parseWslDistroList", () => {
  it("parses distro names, trims CR/blank lines", () => {
    expect(parseWslDistroList("Ubuntu\r\nDebian\r\n\r\n")).toEqual(["Ubuntu", "Debian"]);
  });

  it("returns empty for empty output", () => {
    expect(parseWslDistroList("")).toEqual([]);
  });

  it("drops stray leading/trailing whitespace a decoded line may carry", () => {
    expect(parseWslDistroList("  Ubuntu  \r\n \r\nDebian\r\n")).toEqual(["Ubuntu", "Debian"]);
  });
});

describe("listWslDistros", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("returns [] without calling run on non-win32", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const run = async () => {
      throw new Error("must not be called off win32");
    };
    expect(await listWslDistros(run)).toEqual([]);
  });

  it("parses run's output on win32", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const run = async (cmd: string, args: string[]) => {
      expect(cmd).toBe("wsl.exe");
      expect(args).toEqual(["-l", "-q"]);
      return "Ubuntu\r\nDebian\r\n";
    };
    expect(await listWslDistros(run)).toEqual(["Ubuntu", "Debian"]);
  });

  it("returns [] when run rejects", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const run = async () => {
      throw new Error("wsl.exe not found");
    };
    expect(await listWslDistros(run)).toEqual([]);
  });
});
