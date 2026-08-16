import { describe, expect, it } from "vitest";
import { isIgnoredPath } from "./repo-watcher";

describe("isIgnoredPath (add-windows-support: both separator flavours)", () => {
  it("ignores .git and .rennet on POSIX paths", () => {
    expect(isIgnoredPath("/repo/.git/HEAD")).toBe(true);
    expect(isIgnoredPath("/repo/.rennet/map/x")).toBe(true);
  });

  it("ignores .git and .rennet on Windows/UNC paths (backslashes)", () => {
    expect(isIgnoredPath("\\\\wsl.localhost\\Ubuntu\\home\\rai\\repo\\.git\\HEAD")).toBe(true);
    expect(isIgnoredPath("C:\\dev\\repo\\.rennet\\map\\x")).toBe(true);
  });

  it("does not ignore ordinary source files", () => {
    expect(isIgnoredPath("/repo/src/app.ts")).toBe(false);
    expect(isIgnoredPath("C:\\dev\\repo\\src\\app.ts")).toBe(false);
  });
});
