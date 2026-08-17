import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createEditorLaunchEffects,
  editorLaunchSpec,
  editorOpenArgs,
  isWithinRoot,
  launchResolvedEditor,
  type OpenInEditorEffects,
  performOpenInEditor,
  resolveEditorExecutables,
  resolveWithinRoot,
} from "./open-in-editor";

describe("resolveEditorExecutables", () => {
  it("finds packaged Cursor from its absolute application bundle", async () => {
    const cursor = "/Applications/Cursor.app/Contents/Resources/app/bin/cursor";
    const result = await resolveEditorExecutables(
      { platform: "darwin", home: "/Users/rai", inheritedPath: "", loginShellPath: "" },
      async (candidate) => candidate === cursor,
    );
    expect(result).toEqual([cursor]);
    expect(result.every((candidate) => candidate.startsWith("/"))).toBe(true);
  });

  it.each([
    ["inherited", "/dev/bin", ""],
    ["harvested", "", "/login/bin"],
  ])("finds code on the %s PATH", async (_source, inheritedPath, loginShellPath) => {
    const expected = `${inheritedPath || loginShellPath}/code`;
    const result = await resolveEditorExecutables(
      { platform: "darwin", home: "/Users/rai", inheritedPath, loginShellPath },
      async (candidate) => candidate === expected,
    );
    expect(result).toEqual([expected]);
  });
});

describe("launchResolvedEditor", () => {
  it("falls through failed candidates and preserves the line jump", async () => {
    const spawn = vi.fn(async (executable: string) => {
      if (executable === "/bin/first") throw new Error("failed");
    });
    const launched = await launchResolvedEditor(
      ["/bin/first", "/bin/second"],
      "/repo/src/x.ts",
      42,
      spawn,
    );
    expect(launched).toBe(true);
    expect(spawn).toHaveBeenNthCalledWith(1, "/bin/first", ["-g", "/repo/src/x.ts:42"]);
    expect(spawn).toHaveBeenNthCalledWith(2, "/bin/second", ["-g", "/repo/src/x.ts:42"]);
  });

  it("does not spawn a bare command when no candidate resolves", async () => {
    const spawn = vi.fn<(executable: string, args: string[]) => Promise<void>>();
    expect(await launchResolvedEditor([], "/repo/src/x.ts", 7, spawn)).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("createEditorLaunchEffects", () => {
  it("binds packaged discovery to an absolute Cursor launch and memoizes it", async () => {
    const cursor = "/Applications/Cursor.app/Contents/Resources/app/bin/cursor";
    const resolveExecutables = vi.fn(() =>
      resolveEditorExecutables(
        { platform: "darwin", home: "/Users/rai", inheritedPath: "", loginShellPath: "" },
        async (candidate) => candidate === cursor,
      ),
    );
    const spawned: Array<readonly [string, string[]]> = [];
    const spawn = vi.fn(async (executable: string, args: string[]) => {
      spawned.push([executable, args]);
    });
    const openPath = vi.fn(async () => true);
    const bound = createEditorLaunchEffects({ resolveExecutables, spawn, openPath });

    expect(
      await performOpenInEditor(bound, {
        repositoryRoot: "/repo",
        path: "src/x.ts",
        line: 42,
      }),
    ).toEqual({ ok: true });
    expect(spawn).toHaveBeenCalledWith(cursor, ["-g", `${resolve("/repo", "src/x.ts")}:42`]);
    expect(spawned.every(([command]) => command.startsWith("/"))).toBe(true);
    expect(openPath).not.toHaveBeenCalled();

    await bound.launchAtLine("/repo/src/y.ts", 8);
    expect(resolveExecutables).toHaveBeenCalledTimes(1);
  });
});

describe("editorLaunchSpec", () => {
  it("keeps a Windows .cmd editor shim as the execa target with exact argv", () => {
    expect(
      editorLaunchSpec(
        "C:\\Users\\rai\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd",
        ["--remote", "wsl+Ubuntu", "-g", "/home/rai/my repo/src/app.ts:42"],
      ),
    ).toEqual({
      file: "C:\\Users\\rai\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd",
      args: ["--remote", "wsl+Ubuntu", "-g", "/home/rai/my repo/src/app.ts:42"],
      shell: false,
    });
  });
});

describe("resolveWithinRoot", () => {
  it("resolves a repo-relative path under the root", () => {
    expect(resolveWithinRoot("/repo", "src/x.ts")).toBe(resolve("/repo", "src/x.ts"));
  });
  it("refuses a path that escapes the root", () => {
    expect(resolveWithinRoot("/repo", "../secret.ts")).toBeNull();
    expect(resolveWithinRoot("/repo", "/etc/passwd")).toBeNull();
  });
  it("allows the root itself", () => {
    expect(resolveWithinRoot("/repo", ".")).toBe(resolve("/repo"));
  });
});

describe("resolveEditorExecutables on Windows (packaged-editor-resolution)", () => {
  it("finds VS Code's per-user %LOCALAPPDATA% launcher without a PATH entry", async () => {
    const codeCmd = "C:\\Users\\rai\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd";
    const resolved = await resolveEditorExecutables(
      {
        platform: "win32",
        home: "C:\\Users\\rai",
        inheritedPath: "C:\\Windows\\System32", // no editor CLI on PATH
        loginShellPath: "",
        env: { LOCALAPPDATA: "C:\\Users\\rai\\AppData\\Local" },
      },
      async (candidate) => candidate === codeCmd,
    );
    expect(resolved).toContain(codeCmd);
  });

  // NOTE: resolving a `.cmd` shim that sits on the `;`-delimited PATH relies on
  // win32 `node:path` (delimiter `;`, `\` joins) at runtime on Windows; it cannot be
  // simulated under the ambient POSIX `node:path` in macOS CI. Verified on lancelot.
  // The per-user %LOCALAPPDATA% location above uses explicit win32 joins, so it IS
  // covered here — proving the "installed but not on PATH" scenario.
});

describe("editorOpenArgs (WSL remote)", () => {
  it("uses -g abs:line for the host locus", () => {
    expect(editorOpenArgs("/repo/src/app.ts", 42, { kind: "host" })).toEqual([
      "-g",
      "/repo/src/app.ts:42",
    ]);
  });
  it("targets the editor's WSL remote with the distro-native path", () => {
    expect(
      editorOpenArgs("\\\\wsl.localhost\\Ubuntu\\home\\rai\\repo\\src\\app.ts", 42, {
        kind: "wsl",
        distro: "Ubuntu",
      }),
    ).toEqual(["--remote", "wsl+Ubuntu", "-g", "/home/rai/repo/src/app.ts:42"]);
  });
  it("falls back to -g when a WSL path cannot translate", () => {
    expect(editorOpenArgs("/already/distro/path.ts", 7, { kind: "wsl", distro: "Ubuntu" })).toEqual(
      ["--remote", "wsl+Ubuntu", "-g", "/already/distro/path.ts:7"],
    );
  });
});

describe("isWithinRoot (Windows drive-letter + UNC containment)", () => {
  const win = { sep: "\\", caseInsensitive: true };
  it("accepts a file beneath a drive-letter root", () => {
    expect(isWithinRoot("C:\\dev\\repo", "C:\\dev\\repo\\src\\app.ts", win)).toBe(true);
  });
  it("accepts the root itself", () => {
    expect(isWithinRoot("C:\\dev\\repo", "C:\\dev\\repo", win)).toBe(true);
  });
  it("is case-insensitive on the drive letter (C: vs c:)", () => {
    expect(isWithinRoot("C:\\dev\\repo", "c:\\dev\\repo\\src\\app.ts", win)).toBe(true);
  });
  it("rejects a sibling that shares a prefix but escapes the root", () => {
    expect(isWithinRoot("C:\\dev\\repo", "C:\\dev\\repo-secret\\x.ts", win)).toBe(false);
  });
  it("accepts a file under a WSL UNC root", () => {
    expect(
      isWithinRoot(
        "\\\\wsl.localhost\\Ubuntu\\home\\rai\\repo",
        "\\\\wsl.localhost\\Ubuntu\\home\\rai\\repo\\src\\app.ts",
        win,
      ),
    ).toBe(true);
  });
  it("stays exact (case-sensitive) on POSIX", () => {
    expect(isWithinRoot("/repo", "/repo/src/x.ts", { sep: "/" })).toBe(true);
    expect(isWithinRoot("/repo", "/Repo/src/x.ts", { sep: "/" })).toBe(false);
  });
});

function effects(over: Partial<OpenInEditorEffects> = {}): OpenInEditorEffects {
  return {
    launchAtLine: vi.fn(async () => true),
    openPath: vi.fn(async () => true),
    ...over,
  };
}

describe("performOpenInEditor", () => {
  it("launches at the line when a line is given and an editor takes it", async () => {
    const e = effects();
    const out = await performOpenInEditor(e, {
      repositoryRoot: "/repo",
      path: "src/x.ts",
      line: 42,
    });
    expect(e.launchAtLine).toHaveBeenCalledWith(resolve("/repo", "src/x.ts"), 42, undefined);
    expect(e.openPath).not.toHaveBeenCalled();
    expect(out.ok).toBe(true);
  });

  it("falls back to an OS open when no editor took the line", async () => {
    const e = effects({ launchAtLine: vi.fn(async () => false) });
    const out = await performOpenInEditor(e, {
      repositoryRoot: "/repo",
      path: "src/x.ts",
      line: 7,
    });
    expect(e.launchAtLine).toHaveBeenCalled();
    expect(e.openPath).toHaveBeenCalledWith(resolve("/repo", "src/x.ts"));
    expect(out.ok).toBe(true);
  });

  it("opens without a line when none is given (no editor launch attempted)", async () => {
    const e = effects();
    const out = await performOpenInEditor(e, { repositoryRoot: "/repo", path: "src/x.ts" });
    expect(e.launchAtLine).not.toHaveBeenCalled();
    expect(e.openPath).toHaveBeenCalledWith(resolve("/repo", "src/x.ts"));
    expect(out.ok).toBe(true);
  });

  it("refuses a path that escapes the review root (no launch, no open)", async () => {
    const e = effects();
    const out = await performOpenInEditor(e, {
      repositoryRoot: "/repo",
      path: "../../etc/passwd",
      line: 1,
    });
    expect(out.ok).toBe(false);
    expect(e.launchAtLine).not.toHaveBeenCalled();
    expect(e.openPath).not.toHaveBeenCalled();
  });

  it("reports ok:false when the OS open fails", async () => {
    const e = effects({ openPath: vi.fn(async () => false) });
    const out = await performOpenInEditor(e, { repositoryRoot: "/repo", path: "src/x.ts" });
    expect(out.ok).toBe(false);
  });
});
