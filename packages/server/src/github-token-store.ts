import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GitHubStoredCredential, SecretStore } from "@rennet/adapters";

/**
 * The daemon's GitHub credential vault (v4.3 — the `SecretStore` implementation).
 *
 * A `0600` file under the daemon's data directory — the same trust model as
 * `~/.ssh` keys. Electron `safeStorage` cannot hold this credential: the server
 * runs as a detached Node daemon that serves paired devices with the desktop
 * closed, so the store must be readable without an Electron main process.
 *
 * The file holds ONE credential as JSON: the access token plus the optional
 * expiry/refresh half an expiring-token app configuration mints. A legacy
 * bare-token file (the v4.2 format: the token string alone) still reads — it
 * becomes `{ token }` with no refresh half, exactly a pasted PAT's shape.
 * `null` deletes the file (disconnect).
 */

const FILE_NAME = "github-token";

function parseStored(raw: string): GitHubStoredCredential | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as GitHubStoredCredential;
    if (typeof parsed.token !== "string" || parsed.token.length === 0) return null;
    return parsed;
  }
  // The v4.2 legacy format: the bare token string.
  return { token: trimmed };
}

export function createGitHubTokenStore(dataDir: string): SecretStore {
  const filePath = join(dataDir, FILE_NAME);
  return {
    async getGitHubCredential(): Promise<GitHubStoredCredential | null> {
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
      return parseStored(raw);
    },
    async setGitHubCredential(credential: GitHubStoredCredential | null): Promise<void> {
      if (credential === null) {
        await rm(filePath, { force: true });
        return;
      }
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, `${JSON.stringify(credential)}\n`, { mode: 0o600 });
      // `writeFile`'s mode applies only on CREATE; an overwrite keeps the old bits.
      // Enforce owner-only on every write so a pre-existing permissive file never
      // keeps exposing the fresh credential.
      await chmod(filePath, 0o600);
    },
  };
}
