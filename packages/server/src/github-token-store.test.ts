import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitHubTokenStore } from "./github-token-store";

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), "rennet-token-store-"));
  return { dir, store: createGitHubTokenStore(dir) };
}

const EXPIRING = {
  token: "gho_minted",
  expiresAt: "2026-08-19T20:00:00.000Z",
  refreshToken: "ghr_refresh1",
  refreshTokenExpiresAt: "2027-02-19T12:00:00.000Z",
};

describe("createGitHubTokenStore", () => {
  it("round-trips a full credential and creates the file 0600 (owner-only)", async () => {
    const { dir, store } = await freshStore();
    expect(await store.getGitHubCredential()).toBeNull();
    await store.setGitHubCredential(EXPIRING);
    expect(await store.getGitHubCredential()).toEqual(EXPIRING);
    const mode = (await stat(join(dir, "github-token"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("round-trips a bare-token credential (a pasted PAT: no refresh half)", async () => {
    const { store } = await freshStore();
    await store.setGitHubCredential({ token: "ghp_pasted" });
    expect(await store.getGitHubCredential()).toEqual({ token: "ghp_pasted" });
  });

  it("reads the v4.2 LEGACY bare-token file as a refreshless credential", async () => {
    const { dir, store } = await freshStore();
    await writeFile(join(dir, "github-token"), "gho_legacy\n", { mode: 0o600 });
    expect(await store.getGitHubCredential()).toEqual({ token: "gho_legacy" });
  });

  it("null clears the credential (disconnect) — file gone, reads null", async () => {
    const { dir, store } = await freshStore();
    await store.setGitHubCredential(EXPIRING);
    await store.setGitHubCredential(null);
    expect(await store.getGitHubCredential()).toBeNull();
    await expect(readFile(join(dir, "github-token"), "utf8")).rejects.toThrow();
  });

  it("overwrite replaces the previous credential (rotation persists atomically enough)", async () => {
    const { store } = await freshStore();
    await store.setGitHubCredential(EXPIRING);
    await store.setGitHubCredential({ ...EXPIRING, token: "gho_rotated", refreshToken: "ghr_2" });
    const read = await store.getGitHubCredential();
    expect(read?.token).toBe("gho_rotated");
    expect(read?.refreshToken).toBe("ghr_2");
  });

  it("an empty or whitespace-only file reads as null, never an empty credential", async () => {
    const { dir, store } = await freshStore();
    await writeFile(join(dir, "github-token"), "   \n", { mode: 0o600 });
    expect(await store.getGitHubCredential()).toBeNull();
  });

  it("re-tightens a pre-existing permissive file to 0600 on overwrite", async () => {
    // `writeFile`'s mode applies only on create — this is the regression the chmod
    // exists for: a 0644 file must not keep exposing the freshly written credential.
    const { dir, store } = await freshStore();
    const file = join(dir, "github-token");
    await writeFile(file, "old\n", { mode: 0o644 });
    await chmod(file, 0o644);
    await store.setGitHubCredential({ token: "gho_fresh" });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await store.getGitHubCredential())?.token).toBe("gho_fresh");
  });

  it("SURFACES a non-ENOENT read failure instead of lying not-connected", async () => {
    const { dir, store } = await freshStore();
    // A directory at the credential path is unreadable as a file (EISDIR) — that
    // must throw, never read as "no credential stored".
    await mkdir(join(dir, "github-token"));
    await expect(store.getGitHubCredential()).rejects.toThrow();
  });
});
