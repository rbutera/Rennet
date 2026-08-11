import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileConfigStore, GLOBAL_CONFIG_VERSION } from "./file-config-store";

const dirs: string[] = [];
function tmpConfigPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "rennet-config-"));
  dirs.push(dir);
  return join(dir, "config.json");
}

afterEach(() => {
  dirs.length = 0;
});

describe("FileConfigStore", () => {
  it("reads the default config when the file is absent", () => {
    const store = new FileConfigStore(tmpConfigPath());
    expect(store.read()).toEqual({ version: GLOBAL_CONFIG_VERSION });
  });

  it("persists an appearance scheme and reads it back", () => {
    const path = tmpConfigPath();
    const store = new FileConfigStore(path);
    const written = store.update((current) => ({ ...current, appearance: { scheme: "light" } }));
    expect(written.appearance?.scheme).toBe("light");
    // A fresh store over the same path sees the persisted value (durability).
    expect(new FileConfigStore(path).read().appearance?.scheme).toBe("light");
  });

  it("always stamps the current version, upgrading a legacy shape on write", () => {
    const path = tmpConfigPath();
    writeFileSync(path, JSON.stringify({ version: 0, appearance: { scheme: "dark" } }));
    const written = new FileConfigStore(path).update((current) => current);
    expect(written.version).toBe(GLOBAL_CONFIG_VERSION);
    expect(written.appearance?.scheme).toBe("dark");
  });

  it("degrades a malformed JSON file to defaults WITHOUT rewriting it (Rule 75, wrong-side)", () => {
    const path = tmpConfigPath();
    writeFileSync(path, "{ this is not json");
    const store = new FileConfigStore(path);
    expect(store.read()).toEqual({ version: GLOBAL_CONFIG_VERSION });
    // The unparseable file is left untouched so a human can recover it.
    expect(readFileSync(path, "utf8")).toBe("{ this is not json");
  });

  it("degrades a well-formed-but-invalid document to defaults", () => {
    const path = tmpConfigPath();
    writeFileSync(
      path,
      JSON.stringify({ version: "not-a-number", appearance: { scheme: "chartreuse" } }),
    );
    expect(new FileConfigStore(path).read()).toEqual({ version: GLOBAL_CONFIG_VERSION });
  });
});
