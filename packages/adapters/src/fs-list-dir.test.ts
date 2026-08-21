import { describe, expect, it } from "vitest";
import { defaultFsListDirDeps, listDir } from "./fs-list-dir";

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

  it("propagates a bad TARGET path instead of turning it into an empty success", async () => {
    // A nonexistent / permission-denied target must REJECT (so the browser shows an
    // inline error + keeps Continue disabled), never resolve to `{ entries: [] }`.
    await expect(
      listDir(
        { path: "/no/such/dir" },
        {
          ...deps,
          readEntries: async () => {
            throw new Error("ENOENT: no such file or directory");
          },
        },
      ),
    ).rejects.toThrow(/ENOENT/);
  });

  it("flags a genuinely-unreadable child dir as unreadable (not a false non-repo)", async () => {
    const r = await listDir(
      {},
      {
        ...deps,
        hasGitEntry: async (dir: string) => {
          if (dir === "/home/rai/dev") throw new Error("EACCES: permission denied");
          return false;
        },
      },
    );
    const dev = r.entries.find((e) => e.name === "dev");
    expect(dev?.unreadable).toBe(true);
    expect(dev?.isRepo).toBe(false);
    // A readable sibling is still flagged readable.
    expect(r.entries.find((e) => e.name === ".config")?.unreadable).toBe(false);
  });

  it("defaultFsListDirDeps.hasGitEntry propagates a read failure (no longer swallows to false)", async () => {
    // The root cause of the dead `unreadable` branch: the default probe used to catch its
    // own error and answer `false`. It must now throw so `listDir` can flag the child.
    await expect(
      defaultFsListDirDeps().hasGitEntry("/no/such/dir/definitely/missing"),
    ).rejects.toThrow();
  });
});
