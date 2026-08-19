import { describe, expect, it } from "vitest";

import {
  APP_USER_MODEL_ID,
  brandWindowIcon,
  resolveAppUserModelId,
  SQUIRREL_APP_USER_MODEL_ID,
} from "./window-identity";

describe("window identity", () => {
  it("uses a stable reverse-DNS AppUserModelId", () => {
    expect(APP_USER_MODEL_ID).toBe("com.rennet.desktop");
  });

  it("keeps the reverse-DNS AUMID off win32 regardless of layout", () => {
    // Even if some sibling Update.exe existed, a non-win32 platform never uses the
    // Squirrel id — Squirrel is Windows-only.
    expect(resolveAppUserModelId("darwin", "/Applications/Rennet.app", () => true)).toBe(
      APP_USER_MODEL_ID,
    );
    expect(resolveAppUserModelId("linux", "/opt/rennet/Rennet", () => true)).toBe(
      APP_USER_MODEL_ID,
    );
  });

  it("uses the Squirrel AUMID on a win32 Squirrel install (Update.exe two dirs up)", () => {
    // Forward-slash path so node's default (POSIX, on the test host) `join` treats the
    // segments as segments; on real Windows the same code runs under win32 `join` with
    // backslashes. The layout under test is `…/Root/app-<version>/Rennet.exe`.
    const execPath = "/Root/app-0.1.0/Rennet.exe";
    const seen: string[] = [];
    const aumid = resolveAppUserModelId("win32", execPath, (candidate) => {
      seen.push(candidate);
      return candidate.endsWith("Update.exe");
    });
    expect(aumid).toBe(SQUIRREL_APP_USER_MODEL_ID);
    // The probe is the Root/Update.exe sibling of the app-<version> dir, matching
    // electron-squirrel-startup's own dirname(execPath)/../Update.exe resolution.
    expect(seen[0]).toBe("/Root/Update.exe");
    expect(seen[0]).not.toContain("app-0.1.0");
  });

  it("falls back to the reverse-DNS AUMID on a win32 ZIP/dev run (no Update.exe)", () => {
    expect(resolveAppUserModelId("win32", "/portable/Rennet/Rennet.exe", () => false)).toBe(
      APP_USER_MODEL_ID,
    );
  });

  it("resolves the platform brand icon under brand/exports when present", () => {
    // baseDir is the compiled main's dir (dist/main); the source `src/main` is the
    // same depth from the repo root, so the ../../../../brand hop resolves the real
    // brand export in this repo checkout for the test's own platform.
    const here = new URL(".", import.meta.url).pathname;
    const icon = brandWindowIcon(here, process.platform);
    if (process.platform === "win32") {
      expect(icon).toMatch(/brand[\\/]exports[\\/]app-icons[\\/]windows[\\/]/);
    } else if (process.platform === "linux") {
      expect(icon).toMatch(/brand[\\/]exports[\\/]app-icons[\\/]linux[\\/]/);
    } else {
      expect(icon).toBeUndefined();
    }
  });

  it("degrades to no icon when the brand file is absent", () => {
    expect(brandWindowIcon("/nonexistent/dist/main", "win32")).toBeUndefined();
  });
});

describe("isExternalHttpUrl", () => {
  it("accepts http(s) and nothing else", async () => {
    const { isExternalHttpUrl } = await import("./window-identity");
    expect(isExternalHttpUrl("https://github.com/login/device")).toBe(true);
    expect(isExternalHttpUrl("http://example.test/x")).toBe(true);
    expect(isExternalHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isExternalHttpUrl("app://rennet/")).toBe(false);
    expect(isExternalHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isExternalHttpUrl("not a url")).toBe(false);
  });
});
