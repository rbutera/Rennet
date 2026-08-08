import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileSettingsStore } from "./file-settings-store";

function tempPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "rennet-settings-"));
  return {
    path: join(dir, "nested", "settings.json"),
    cleanup: () => rmSync(dir, { recursive: true }),
  };
}

describe("FileSettingsStore — workspace permission mode (issue #103)", () => {
  it("reads the safe `manual` default before anything is written", () => {
    const { path, cleanup } = tempPath();
    try {
      expect(new FileSettingsStore(path).permissionMode()).toBe("manual");
    } finally {
      cleanup();
    }
  });

  it("persists a written mode across store instances (a new process reads it back)", () => {
    const { path, cleanup } = tempPath();
    try {
      new FileSettingsStore(path).setPermissionMode("auto");
      // RED: make setPermissionMode a no-op → the fresh instance reads "manual".
      expect(new FileSettingsStore(path).permissionMode()).toBe("auto");
    } finally {
      cleanup();
    }
  });

  it("round-trips each mode", () => {
    const { path, cleanup } = tempPath();
    try {
      const store = new FileSettingsStore(path);
      for (const mode of ["auto", "bypass", "manual"] as const) {
        store.setPermissionMode(mode);
        expect(store.permissionMode()).toBe(mode);
      }
    } finally {
      cleanup();
    }
  });

  it("fails SAFE to `manual` on a corrupt file, never to bypass (Rule 75 wrong-side)", () => {
    const { path, cleanup } = tempPath();
    try {
      const store = new FileSettingsStore(path); // creates the dir
      writeFileSync(path, "{ this is not json");
      expect(store.permissionMode()).toBe("manual");
    } finally {
      cleanup();
    }
  });

  it("fails SAFE to `manual` on an unrecognised persisted value", () => {
    const { path, cleanup } = tempPath();
    try {
      const store = new FileSettingsStore(path);
      writeFileSync(path, JSON.stringify({ permissionMode: "yolo" }));
      expect(store.permissionMode()).toBe("manual");
    } finally {
      cleanup();
    }
  });

  it("rejects an unrecognised mode on write and leaves the file unchanged", () => {
    const { path, cleanup } = tempPath();
    try {
      const store = new FileSettingsStore(path);
      store.setPermissionMode("bypass");
      // @ts-expect-error — exercising the runtime guard with an invalid value.
      expect(() => store.setPermissionMode("nope")).toThrow();
      expect(store.permissionMode()).toBe("bypass"); // prior value survives
    } finally {
      cleanup();
    }
  });
});
