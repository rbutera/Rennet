import { describe, expect, it } from "vitest";
import { listDir } from "./fs-list-dir";

const deps = {
  homedir: () => "/home/rai",
  readEntries: async (dir: string) =>
    dir === "/home/rai"
      ? [
          { name: "dev", isDirectory: true },
          { name: ".config", isDirectory: true },
          { name: "notes.txt", isDirectory: false },
        ]
      : [],
  hasGitEntry: async (dir: string) => dir === "/home/rai/dev",
};

describe("listDir", () => {
  it("lists directories only, includes hidden, flags repos, defaults to home", async () => {
    const r = await listDir({}, deps);
    expect(r.path).toBe("/home/rai");
    expect(r.home).toBe("/home/rai");
    expect(r.parent).toBe("/home");
    expect(r.entries.map((e) => e.name)).toEqual([".config", "dev"]); // name-sorted, no files
    expect(r.entries.find((e) => e.name === "dev")?.isRepo).toBe(true);
    expect(r.entries.find((e) => e.name === ".config")?.isRepo).toBe(false);
  });

  it("returns null parent at filesystem root", async () => {
    const r = await listDir({ path: "/" }, { ...deps, readEntries: async () => [] });
    expect(r.parent).toBeNull();
  });
});
