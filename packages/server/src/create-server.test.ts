import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRennetServer } from "./create-server";

// Pins design D4 (no module-level singletons — two servers in one process do not
// share mutable state) and D5 (shutdown is idempotent). The handle is {dispatch,
// shutdown}; the observable per-instance state we can reach without Electron is the
// dataDir-scoped store, so distinct dataDirs must yield distinct SQLite files.
describe("createRennetServer — instance isolation + shutdown (#377)", () => {
  const dirs: string[] = [];
  const make = () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rennet-server-"));
    dirs.push(dataDir);
    return createRennetServer({ dataDir, env: {} });
  };
  // `createRennetServer` is async (#378: it resolves after the WS listener is
  // listening), so every construction below awaits the handle.
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("two instances own separate dataDir-scoped stores", async () => {
    const a = await make();
    const b = await make();
    // A shared module-level store would have opened ONE sqlite; each instance opening
    // its own file under its own dataDir is the visible proof the store is instance state.
    expect(existsSync(join(dirs[0] ?? "", "rennet.sqlite"))).toBe(true);
    expect(existsSync(join(dirs[1] ?? "", "rennet.sqlite"))).toBe(true);
    expect(a.dispatch).not.toBe(b.dispatch);
    expect(a.shutdown).not.toBe(b.shutdown);
    a.shutdown();
    b.shutdown();
  });

  it("shutdown is idempotent and instance-scoped", async () => {
    const a = await make();
    const b = await make();
    // Second shutdown of the same instance is a no-op (D5), and shutting a down never
    // reaches into b — each closes only its own watcher, rehydration, and store.
    expect(() => {
      a.shutdown();
      a.shutdown();
    }).not.toThrow();
    expect(() => b.shutdown()).not.toThrow();
  });
});
