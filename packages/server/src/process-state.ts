// Is that pid a process that can still do work? (#820)
//
// `process.kill(pid, 0)` answers "the process table has an entry", which is NOT the same
// question. A child that has exited but has not been waited on keeps its entry — it is a
// ZOMBIE — and signal-0 reports it alive forever, or until its parent reaps it. That is what
// stranded the 0.6.5 → 0.7.0 update: the daemon exited cleanly on SIGTERM and removed its
// claim, the Electron main process never reaped it, and the supervisor's pid probe waited
// out its whole budget on a process that had already gone.
//
// A zombie holds no file descriptors, no ports and no app bundle, so for every question a
// launcher actually asks — may the installer replace this bundle? is a daemon serving this
// data dir? — it is gone. The extra state matters only for saying WHICH thing is true in a
// failure message, so the primitive answers three ways and `isRunning` is the predicate.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export type ProcessState =
  /** A live process: it can hold ports, descriptors and the app bundle. */
  | "running"
  /** Exited, not yet reaped by its parent. Holds nothing; still answers `kill(pid, 0)`. */
  | "zombie"
  /** No process table entry at all. */
  | "gone";

/** Read a pid's state, distinguishing a zombie from a live process. */
export function processState(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): ProcessState {
  try {
    process.kill(pid, 0);
  } catch (error) {
    // ESRCH is the only code that means "no such process". EPERM means it exists and belongs
    // to another user — alive, and not ours to inspect further.
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "running";
  }
  return isZombie(pid, platform) ? "zombie" : "running";
}

/** Can this pid still do work? A zombie cannot, so it answers false. */
export function isRunning(pid: number, platform: NodeJS.Platform = process.platform): boolean {
  return processState(pid, platform) === "running";
}

/**
 * The platform's zombie check. Windows has no zombie state (a handle keeps an exit code, not
 * a process), so it never reports one. Linux reads `/proc/<pid>/stat`, whose state letter is
 * the field after the LAST `)` — the comm field can itself contain parentheses and spaces.
 * Everything else asks `ps`. An unreadable answer is not evidence of a zombie: it answers false.
 */
function isZombie(pid: number, platform: NodeJS.Platform): boolean {
  try {
    if (platform === "win32") return false;
    if (platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const afterComm = stat.slice(stat.lastIndexOf(")") + 1).trim();
      return afterComm.startsWith("Z");
    }
    const state = execFileSync("ps", ["-o", "state=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return state.trim().startsWith("Z");
  } catch {
    return false;
  }
}
