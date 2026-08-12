import { describe, expect, it, vi } from "vitest";
import {
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
    const spawn = vi.fn(async () => Promise.resolve());
    expect(await launchResolvedEditor([], "/repo/src/x.ts", 7, spawn)).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("resolveWithinRoot", () => {
  it("resolves a repo-relative path under the root", () => {
    expect(resolveWithinRoot("/repo", "src/x.ts")).toBe("/repo/src/x.ts");
  });
  it("refuses a path that escapes the root", () => {
    expect(resolveWithinRoot("/repo", "../secret.ts")).toBeNull();
    expect(resolveWithinRoot("/repo", "/etc/passwd")).toBeNull();
  });
  it("allows the root itself", () => {
    expect(resolveWithinRoot("/repo", ".")).toBe("/repo");
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
    expect(e.launchAtLine).toHaveBeenCalledWith("/repo/src/x.ts", 42);
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
    expect(e.openPath).toHaveBeenCalledWith("/repo/src/x.ts");
    expect(out.ok).toBe(true);
  });

  it("opens without a line when none is given (no editor launch attempted)", async () => {
    const e = effects();
    const out = await performOpenInEditor(e, { repositoryRoot: "/repo", path: "src/x.ts" });
    expect(e.launchAtLine).not.toHaveBeenCalled();
    expect(e.openPath).toHaveBeenCalledWith("/repo/src/x.ts");
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
