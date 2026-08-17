import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultCodexTransportEffects } from "./codex-turn-transport";

async function waitForPid(path: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const value = Number((await readFile(path, "utf8")).trim());
      if (Number.isInteger(value) && value > 0) return value;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("descendant pid was not written");
}

async function waitForExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } catch {
      return;
    }
  }
  throw new Error(`descendant ${pid} survived transport cancellation`);
}

describe("Codex process transport", () => {
  it.skipIf(process.platform === "win32")(
    "kills a Node launcher and its long-lived descendant on abort",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "rennet-codex-tree-"));
      const pidPath = join(dir, "descendant.pid");
      const outPath = join(dir, "last-message.txt");
      const launcher = [
        'const { spawn } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        "writeFileSync(process.argv[1], String(child.pid));",
        "setInterval(() => {}, 1000);",
      ].join("");
      const abort = new AbortController();
      try {
        const draining = (async () => {
          for await (const frame of defaultCodexTransportEffects.spawn(
            process.execPath,
            ["-e", launcher, pidPath],
            dir,
            outPath,
            abort.signal,
          )) {
            // Drain through the synthetic terminal frame so process completion is observed.
            void frame;
          }
        })();
        const descendantPid = await waitForPid(pidPath);
        abort.abort();
        await draining;
        await waitForExit(descendantPid);
        expect(() => process.kill(descendantPid, 0)).toThrow();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
