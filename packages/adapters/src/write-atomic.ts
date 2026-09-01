import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Atomic write to `path`, creating parent dirs (temp + rename on one filesystem). */
export function writeAtomic(path: string, bytes: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, path);
}
