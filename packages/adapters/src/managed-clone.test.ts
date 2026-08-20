import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureManagedClone, managedCloneRoot } from "./managed-clone";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rennet-clone-"));
  scratch.push(dir);
  return dir;
}

describe("ensureManagedClone", () => {
  it("clones bloblessly into <dataDir>/clones/<owner>/<name> on first use", async () => {
    const dir = dataDir();
    const runClone = vi.fn(async (_url: string, target: string) => {
      mkdirSync(join(target, ".git"), { recursive: true });
    });
    const root = await ensureManagedClone(dir, { owner: "acme", name: "widget" }, runClone);
    expect(root).toBe(managedCloneRoot(dir, { owner: "acme", name: "widget" }));
    expect(runClone).toHaveBeenCalledWith("https://github.com/acme/widget.git", root);
  });

  it("reuses an existing clone without cloning again", async () => {
    const dir = dataDir();
    mkdirSync(join(managedCloneRoot(dir, { owner: "acme", name: "widget" }), ".git"), {
      recursive: true,
    });
    const runClone = vi.fn(() => Promise.resolve());
    await ensureManagedClone(dir, { owner: "acme", name: "widget" }, runClone);
    expect(runClone).not.toHaveBeenCalled();
  });

  it("wraps a clone failure in an actionable error (pick a clone instead)", async () => {
    const dir = dataDir();
    const runClone = vi.fn(async () => {
      throw new Error("fatal: could not read Username");
    });
    await expect(
      ensureManagedClone(dir, { owner: "acme", name: "private" }, runClone),
    ).rejects.toThrow(/Pick a local clone/);
  });
});
