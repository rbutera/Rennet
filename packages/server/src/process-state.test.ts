import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isRunning, processState } from "./process-state";

// The predicate this file exists for is the one #820 was decided by: a daemon that had already
// exited kept answering `process.kill(pid, 0)` because nobody had reaped it, and the desktop
// supervisor waited out its whole budget, refused the installer handoff, and told the user the
// daemon was "still present" while `ps` showed `Z <defunct>`.
//
// So these tests build a REAL zombie rather than stubbing one: a helper process spawns a child,
// the child exits, and the helper blocks its event loop so libuv never reaps it. Nothing here
// asserts against a fake; the assertions run against a pid the kernel really is holding open.

/** A helper that spawns a child, prints its pid, lets it die, and never reaps it. */
const ZOMBIE_MAKER = `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
process.stdout.write(String(child.pid) + "\\n");
// Blocking the main thread means libuv never runs the SIGCHLD handling that would waitpid the
// child. The pid therefore stays in the process table as a zombie for as long as we sit here.
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);
`;

/** The OS's own answer, read independently of the module under test. */
function psState(pid: number): string {
  try {
    return execFileSync("ps", ["-o", "state=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition never held");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("processState (#820: a zombie is not a running daemon)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  it.skipIf(process.platform === "win32")(
    "reports a REAL zombie as not running, where kill(pid, 0) still says alive",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "rennet-zombie-"));
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
      const script = join(dir, "zombie-maker.cjs");
      writeFileSync(script, ZOMBIE_MAKER);

      const helper = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "ignore"] });
      cleanups.push(() => helper.kill("SIGKILL"));
      const pid = await new Promise<number>((resolve, reject) => {
        helper.stdout.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
        helper.once("error", reject);
      });
      expect(pid).toBeGreaterThan(0);

      // `ps` is the independent observation: wait for the kernel to say Z before asserting.
      await waitFor(() => psState(pid).startsWith("Z"));

      // The predicate the supervisor used to run. It is not wrong — the entry IS there — it
      // just does not answer the question a launcher is asking.
      expect(() => process.kill(pid, 0)).not.toThrow();
      // The predicate it runs now: that process can do no work, hold no port, hold no bundle.
      expect(processState(pid)).toBe("zombie");
      expect(isRunning(pid)).toBe(false);

      // …and the same call on a live process still says running, so `false` is not the only
      // answer this can give.
      expect(processState(helper.pid ?? 0)).toBe("running");
      expect(isRunning(process.pid)).toBe(true);
    },
    20_000,
  );

  it("reports a reaped process as gone", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      stdio: "ignore",
    });
    const pid = child.pid ?? 0;
    expect(isRunning(pid)).toBe(true);
    child.kill("SIGKILL");
    // This process spawned it, so Node reaps it here: no zombie, no process table entry.
    await new Promise((resolve) => child.once("exit", resolve));
    expect(processState(pid)).toBe("gone");
    expect(isRunning(pid)).toBe(false);
  });

  it("never reports a zombie on win32, which has no such state", () => {
    // The platform seam is explicit so the branch is reachable from any host: on Windows a pid
    // that answers signal-0 is running, full stop.
    expect(processState(process.pid, "win32")).toBe("running");
    expect(isRunning(process.pid, "win32")).toBe(true);
  });
});
