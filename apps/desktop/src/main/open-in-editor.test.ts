import { describe, expect, it, vi } from "vitest";
import { type OpenInEditorEffects, performOpenInEditor, resolveWithinRoot } from "./open-in-editor";

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
