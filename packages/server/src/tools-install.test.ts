import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DetectedSourceControlTool } from "@rennet/adapters";
import type { CommandOutput, ProjectProgressEvent } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createRennetServer } from "./create-server";

/**
 * `tools.install` (review-preparation-reliability 2.4, source-control-tooling spec): the
 * installer's output streams as `tool-install-output` events under the command id while it
 * runs, the tool is re-probed afterwards, and the result is the re-probed state. Homebrew
 * and git are stubs in a directory of their own, so the run is the same on every machine.
 */

const dirs: string[] = [];
const shutdowns: (() => void)[] = [];
afterEach(() => {
  for (const shutdown of shutdowns.splice(0)) shutdown();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stub(dir: string, name: string, body: string): void {
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
}

async function installer(brew: string, git: string) {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "rennet-tools-data-")));
  const bin = realpathSync(mkdtempSync(join(tmpdir(), "rennet-tools-brew-")));
  dirs.push(dataDir, bin);
  stub(bin, "brew", brew);
  stub(bin, "git", git);
  // The probe answers "installed" only once the stub brew has left its mark.
  const installed = join(bin, "installed");
  const events: { commandId: string; event: ProjectProgressEvent }[] = [];
  const server = await createRennetServer({
    dataDir,
    env: {},
    broadcastProgress: (commandId, event) => events.push({ commandId, event }),
    sourceControl: {
      installPlanDeps: { platform: "darwin", envPath: "", brewDirectories: [bin] },
      detect: async (): Promise<readonly DetectedSourceControlTool[]> => {
        const present = existsSync(installed);
        return [
          { id: "git", version: "2.53.0", status: "available", path: "/usr/bin/git", detail: "" },
          present
            ? { id: "git-lfs", version: "3.7.0", status: "available", path: null, detail: "" }
            : { id: "git-lfs", version: null, status: "not-installed", path: null, detail: "" },
        ];
      },
    },
  });
  shutdowns.push(server.shutdown);
  return { server, events };
}

describe("tools.install (Install for me)", () => {
  it.skipIf(process.platform === "win32")(
    "runs brew then git lfs install, streams both, and answers with the re-probed tool",
    async () => {
      const { server, events } = await installer(
        'echo "==> Pouring git-lfs"; touch "$(dirname "$0")/installed"',
        'echo "Git LFS initialized."',
      );
      const commandId = randomUUID();
      const { result } = (await server.dispatch("tools.install", {
        tool: "git-lfs",
        locus: { kind: "host" },
        commandId,
      })) as CommandOutput<"tools.install">;

      expect(result.status).toBe("installed");
      if (result.status !== "installed") throw new Error("not installed");
      expect(result.command).toBe("brew install git-lfs && git lfs install");
      expect(result.probe).toEqual({
        id: "git-lfs",
        version: "3.7.0",
        status: "available",
        detail: "",
      });
      // Streamed, under THIS command's id, in order: each step's line, then its output.
      const chunks = events
        .filter((entry) => entry.commandId === commandId)
        .map((entry) => entry.event as unknown as { kind: string; tool: string; chunk: string });
      expect(chunks.every((chunk) => chunk.kind === "tool-install-output")).toBe(true);
      expect(chunks.every((chunk) => chunk.tool === "git-lfs")).toBe(true);
      const text = chunks.map((chunk) => chunk.chunk).join("");
      const order = [
        "$ brew install git-lfs",
        "==> Pouring git-lfs",
        "$ git lfs install",
        "Git LFS initialized.",
      ].map((line) => text.indexOf(line));
      expect(order.every((index) => index >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(result.output).toContain("Git LFS initialized.");
    },
  );

  it.skipIf(process.platform === "win32")(
    "a failing installer reports the failed step plainly, with its output, and the tool still missing",
    async () => {
      const { server, events } = await installer(
        'echo "Error: git-lfs: no bottle available" >&2; exit 1',
        "exit 0",
      );
      const commandId = randomUUID();
      const { result } = (await server.dispatch("tools.install", {
        tool: "git-lfs",
        locus: { kind: "host" },
        commandId,
      })) as CommandOutput<"tools.install">;

      expect(result.status).toBe("failed");
      if (result.status !== "failed") throw new Error("did not fail");
      expect(result.message).toBe("Git LFS couldn't be installed.");
      expect(result.failedCommand).toBe("brew install git-lfs");
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("no bottle available");
      expect(result.probe.status).toBe("not-installed");
      // The failure streamed too, and no later step ran.
      const text = events
        .filter((entry) => entry.commandId === commandId)
        .map((entry) => (entry.event as unknown as { chunk: string }).chunk)
        .join("");
      expect(text).toContain("no bottle available");
      expect(text).not.toContain("$ git lfs install");
    },
  );

  it("a WSL distro gets the manual Linux command and a link, and nothing runs", async () => {
    const { server, events } = await installer("exit 1", "exit 1");
    const commandId = randomUUID();
    const { result } = (await server.dispatch("tools.install", {
      tool: "git-lfs",
      locus: { kind: "wsl", distro: "Ubuntu" },
      commandId,
    })) as CommandOutput<"tools.install">;
    expect(result).toMatchObject({
      status: "manual",
      command: "sudo apt-get install git-lfs && git lfs install",
      docsUrl: "https://git-lfs.com",
    });
    expect(events.filter((entry) => entry.commandId === commandId)).toEqual([]);
  });

  it("tools.cancelInstall says false when nothing by that id is running", async () => {
    const { server } = await installer("exit 0", "exit 0");
    expect(await server.dispatch("tools.cancelInstall", { commandId: randomUUID() })).toEqual({
      cancelled: false,
    });
  });
});
