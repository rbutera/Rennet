import { describe, expect, it } from "vitest";

import { APP_USER_MODEL_ID, brandWindowIcon } from "./window-identity";

describe("window identity", () => {
  it("uses a stable reverse-DNS AppUserModelId", () => {
    expect(APP_USER_MODEL_ID).toBe("com.rennet.desktop");
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
