// The daemon discovery file (`<dataDir>/daemon.json`, issue #379). A launcher — the
// desktop shell or the `rennet` CLI — treats it as a CLAIM to verify, never as truth:
// it names where a daemon says it is listening, and the launcher probes `/healthz`
// before trusting it. Written atomically (temp + rename, the FileThreadStore pattern)
// after the listener is up; removed on clean shutdown. A stale file (dead pid / failed
// probe) is simply overwritten by the next spawn. The schema lives here, in the server
// package, because it never crosses to a browser — it is not protocol wire surface.

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const daemonInfoSchema = z.object({
  /** The daemon process id, so a launcher can signal it (`rennet stop`) and check liveness. */
  pid: z.number().int().positive(),
  /** The loopback port the WS listener bound; a client dials `ws://127.0.0.1:<wsPort>`. */
  wsPort: z.number().int().positive(),
  /** The wire protocol version, cross-checked against the launcher's compatibility window. */
  protocolVersion: z.number().int().nonnegative(),
  /** The server/app version string, for display (`rennet status`). Not a compatibility input. */
  version: z.string(),
  /** ISO timestamp the daemon came up, for display. */
  startedAt: z.string(),
});

export type DaemonInfo = z.infer<typeof daemonInfoSchema>;

/** The claim file path for a data dir. */
export function daemonFilePath(dataDir: string): string {
  return join(dataDir, "daemon.json");
}

/** Write the claim atomically (temp + rename), creating the data dir if needed. */
export function writeDaemonFile(dataDir: string, info: DaemonInfo): void {
  mkdirSync(dataDir, { recursive: true });
  const path = daemonFilePath(dataDir);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(info, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Read + validate the claim; `null` if the file is missing, unreadable, torn, or malformed. */
export function readDaemonFile(dataDir: string): DaemonInfo | null {
  try {
    const raw = readFileSync(daemonFilePath(dataDir), "utf8");
    const parsed = daemonInfoSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Remove the claim only while it still belongs to `expectedPid`. */
export function removeDaemonFile(dataDir: string, expectedPid: number): boolean {
  const claim = readDaemonFile(dataDir);
  if (claim?.pid !== expectedPid) return false;
  try {
    unlinkSync(daemonFilePath(dataDir));
    return true;
  } catch {
    return false;
  }
}
