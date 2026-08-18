import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SecretStore } from "@rennet/adapters";

/**
 * The daemon's GitHub token vault (v4.2 — the `SecretStore` implementation).
 *
 * A `0600` file under the daemon's data directory — the same trust model as
 * `~/.ssh` keys and gh's own `hosts.yml`. Electron `safeStorage` cannot hold
 * this token: the server runs as a detached Node daemon that serves paired
 * devices with the desktop closed, so the store must be readable without an
 * Electron main process. The file holds ONE token (device-flow-minted or a
 * pasted PAT — same store, same treatment); `null` deletes it (disconnect).
 */

const FILE_NAME = "github-token";

export function createGitHubTokenStore(dataDir: string): SecretStore {
  const filePath = join(dataDir, FILE_NAME);
  return {
    async getGitHubToken(): Promise<string | null> {
      let raw: string;
      try {
        raw = await readFile(filePath, "utf8");
      } catch (error) {
        // Only "no file" is the honest not-connected state. Any other read failure
        // (EACCES, EISDIR, corruption) must SURFACE — reporting it as "no token"
        // would tell the user to reconnect over a store that cannot be read.
        if ((error as { code?: string }).code === "ENOENT") return null;
        throw error;
      }
      const token = raw.trim();
      return token.length > 0 ? token : null;
    },
    async setGitHubToken(token: string | null): Promise<void> {
      if (token === null) {
        await rm(filePath, { force: true });
        return;
      }
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, `${token}\n`, { mode: 0o600 });
      // `writeFile`'s mode applies only on CREATE; an overwrite keeps the old bits.
      // Enforce owner-only on every write so a pre-existing permissive file never
      // keeps exposing the fresh token.
      await chmod(filePath, 0o600);
    },
  };
}
