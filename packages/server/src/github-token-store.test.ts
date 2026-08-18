import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitHubTokenStore } from "./github-token-store";

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), "rennet-token-store-"));
  return { dir, store: createGitHubTokenStore(dir) };
}

describe("createGitHubTokenStore", () => {
  it("round-trips a token and creates the file 0600 (owner-only)", async () => {
    const { dir, store } = await freshStore();
    expect(await store.getGitHubToken()).toBeNull();
    await store.setGitHubToken("gho_minted");
    expect(await store.getGitHubToken()).toBe("gho_minted");
    const mode = (await stat(join(dir, "github-token"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("null clears the token (disconnect) — file gone, reads null", async () => {
    const { dir, store } = await freshStore();
    await store.setGitHubToken("gho_minted");
    await store.setGitHubToken(null);
    expect(await store.getGitHubToken()).toBeNull();
    await expect(readFile(join(dir, "github-token"), "utf8")).rejects.toThrow();
  });

  it("overwrite replaces the previous token (paste over device-flow, same store)", async () => {
    const { store } = await freshStore();
    await store.setGitHubToken("gho_device");
    await store.setGitHubToken("ghp_pasted");
    expect(await store.getGitHubToken()).toBe("ghp_pasted");
  });

  it("an empty or whitespace-only file reads as null, never an empty token", async () => {
    const { store } = await freshStore();
    await store.setGitHubToken("   ");
    expect(await store.getGitHubToken()).toBeNull();
  });

  it("re-tightens a pre-existing permissive file to 0600 on overwrite", async () => {
    // `writeFile`'s mode applies only on create — this is the regression the chmod
    // exists for: a 0644 file must not keep exposing the freshly written token.
    const { dir, store } = await freshStore();
    const file = join(dir, "github-token");
    await writeFile(file, "old\n", { mode: 0o644 });
    await chmod(file, 0o644);
    await store.setGitHubToken("gho_fresh");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await store.getGitHubToken()).toBe("gho_fresh");
  });

  it("SURFACES a non-ENOENT read failure instead of lying not-connected", async () => {
    const { dir, store } = await freshStore();
    // A directory at the token path is unreadable as a file (EISDIR) — that must
    // throw, never read as "no token stored".
    await mkdir(join(dir, "github-token"));
    await expect(store.getGitHubToken()).rejects.toThrow();
  });
});
