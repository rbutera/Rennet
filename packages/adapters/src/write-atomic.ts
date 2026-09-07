import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Atomic write to `path`, creating parent dirs (temp + rename on one filesystem). Takes
 *  raw bytes as well as text, so a copied image rides the same atomic write as a JSON file. */
export function writeAtomic(path: string, bytes: string | Uint8Array): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, path);
}
