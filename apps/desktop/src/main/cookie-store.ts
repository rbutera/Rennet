import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Run before Electron opens its session; encrypted cookies cannot survive the fuse change. */
export function archiveEncryptedCookies(sessionData: string): void {
  const archive = join(sessionData, "encrypted-cookies-backup");
  const complete = join(archive, "complete");
  if (existsSync(complete)) return;
  mkdirSync(archive, { recursive: true, mode: 0o700 });
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const name = `Cookies${suffix}`;
    const source = join(sessionData, name);
    if (existsSync(source)) renameSync(source, join(archive, name));
  }
  // Written last so an interrupted migration resumes before any new cookies are created.
  writeFileSync(complete, "", { mode: 0o600 });
}
