import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DetectedSourceControlTool } from "@rennet/adapters";
import type { CommandOutput, ProjectProgressEvent } from "@rennet/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRennetServer } from "./create-server";

/**
 * `tools.install` (review-preparation-reliability 2.4, source-control-tooling spec): the
 * installer's output streams as `tool-install-output` events under the command id while it
 * runs, the tool is re-probed afterwards, and the result is the re-probed state. Homebrew
 * and git are stubs in a directory of their own, so the run is the same on every machine.
 */

const dirs: string[] = [];
const shutdowns: (() => unknown)[] = [];
afterEach(() => {
  for (const shutdown of shutdowns.splice(0)) shutdown();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stub(dir: string, name: string, body: string): void {
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
}

async function installer(brew: string, git: string, opts: { probeThrows?: () => boolean } = {}) {
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
        if (opts.probeThrows?.() === true) throw new Error("acme probe is unavailable");
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
  return { server, events, bin, installed };
}

/** Wait until the stub installer has said `line` under `commandId`. */
async function heard(
  events: { commandId: string; event: ProjectProgressEvent }[],
  commandId: string,
  line: string,
): Promise<void> {
  await vi.waitFor(
    () =>
      expect(
        events
          .filter((entry) => entry.commandId === commandId)
          .map((entry) => (entry.event as unknown as { chunk: string }).chunk)
          .join(""),
      ).toContain(line),
    { timeout: 10_000, interval: 10 },
  );
}

/** A brew that says it started, counts its runs, sleeps, and only then installs. */
const SLEEPING_BREW =
  'echo "==> starting"; echo run >> "$(dirname "$0")/runs"; sleep 2; touch "$(dirname "$0")/installed"';

function runsOf(bin: string): number {
  return existsSync(join(bin, "runs"))
    ? readFileSync(join(bin, "runs"), "utf8").split("\n").filter(Boolean).length
    : 0;
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

  it.skipIf(process.platform === "win32")(
    "shutting the server down stops a running install: nothing more is installed, and it says cancelled",
    async () => {
      const { server, events, installed } = await installer(SLEEPING_BREW, "exit 0");
      const commandId = randomUUID();
      const pending = server.dispatch("tools.install", {
        tool: "git-lfs",
        locus: { kind: "host" },
        commandId,
      }) as Promise<CommandOutput<"tools.install">>;
      await heard(events, commandId, "==> starting");
      await server.shutdown();
      const { result } = await pending;
      expect(result.status).toBe("failed");
      if (result.status !== "failed") throw new Error("did not fail");
      expect(result.cancelled).toBe(true);
      // Past the moment the sleeping installer would have finished: it never did.
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(existsSync(installed)).toBe(false);
    },
    20_000,
  );

  it.skipIf(process.platform === "win32")(
    "a second Install for me for the same tool joins the running one: one brew, both hear it",
    async () => {
      const { server, events, bin } = await installer(SLEEPING_BREW, "exit 0");
      const first = randomUUID();
      const second = randomUUID();
      const install = (commandId: string) =>
        server.dispatch("tools.install", {
          tool: "git-lfs",
          locus: { kind: "host" },
          commandId,
        }) as Promise<CommandOutput<"tools.install">>;
      const one = install(first);
      await heard(events, first, "==> starting");
      const two = install(second);
      const [a, b] = await Promise.all([one, two]);
      expect(a.result.status).toBe("installed");
      expect(b.result).toEqual(a.result);
      expect(runsOf(bin)).toBe(1);
      // The command that joined late heard what had already streamed, under its own id.
      await heard(events, second, "==> starting");
      await heard(events, second, "$ git lfs install");
    },
    20_000,
  );

  it.skipIf(process.platform === "win32")(
    "tools.cancelInstall stops a RUNNING install, by any command that started or joined it",
    async () => {
      const { server, events, installed } = await installer(SLEEPING_BREW, "exit 0");
      const first = randomUUID();
      const joined = randomUUID();
      const pending = server.dispatch("tools.install", {
        tool: "git-lfs",
        locus: { kind: "host" },
        commandId: first,
      }) as Promise<CommandOutput<"tools.install">>;
      await heard(events, first, "==> starting");
      const alsoPending = server.dispatch("tools.install", {
        tool: "git-lfs",
        locus: { kind: "host" },
        commandId: joined,
      }) as Promise<CommandOutput<"tools.install">>;
      expect(await server.dispatch("tools.cancelInstall", { commandId: joined })).toEqual({
        cancelled: true,
      });
      const [{ result }, { result: same }] = await Promise.all([pending, alsoPending]);
      expect(result.status).toBe("failed");
      if (result.status !== "failed") throw new Error("did not fail");
      expect(result.cancelled).toBe(true);
      expect(same).toEqual(result);
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(existsSync(installed)).toBe(false);
      // Nothing is running any more, so a cancel finds nothing.
      expect(await server.dispatch("tools.cancelInstall", { commandId: first })).toEqual({
        cancelled: false,
      });
    },
    20_000,
  );

  it.skipIf(process.platform === "win32")(
    "Install for me right after a cancel, while the cancelled run is still dying, starts a fresh install",
    async () => {
      // A brew that ignores SIGTERM, so the cancelled run lingers until the SIGKILL grace ends.
      const { server, events, bin } = await installer(
        `trap "" TERM; ${SLEEPING_BREW.replace("sleep 2", "sleep 3")}`,
        "exit 0",
      );
      const install = (commandId: string) =>
        server.dispatch("tools.install", {
          tool: "git-lfs",
          locus: { kind: "host" },
          commandId,
        }) as Promise<CommandOutput<"tools.install">>;
      const first = randomUUID();
      const cancelled = install(first);
      await heard(events, first, "==> starting");
      expect(await server.dispatch("tools.cancelInstall", { commandId: first })).toEqual({
        cancelled: true,
      });
      // Within the kill grace: the cancelled run has not ended yet.
      const again = randomUUID();
      const { result } = await install(again);
      expect((await cancelled).result).toMatchObject({ status: "failed", cancelled: true });
      // The reviewer asked to install, not to hear the cancelled run's ending: a new brew ran.
      expect(result.status).toBe("installed");
      expect(runsOf(bin)).toBe(2);
      await heard(events, again, "$ git lfs install");
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "cancelling the fresh install while it waits for the cancelled one to die starts nothing",
    async () => {
      const { server, events, bin } = await installer(
        `trap "" TERM; ${SLEEPING_BREW.replace("sleep 2", "sleep 3")}`,
        "exit 0",
      );
      const install = (commandId: string) =>
        server.dispatch("tools.install", {
          tool: "git-lfs",
          locus: { kind: "host" },
          commandId,
        }) as Promise<CommandOutput<"tools.install">>;
      const first = randomUUID();
      const cancelled = install(first);
      await heard(events, first, "==> starting");
      expect(await server.dispatch("tools.cancelInstall", { commandId: first })).toEqual({
        cancelled: true,
      });
      // The retry queues behind the dying run; cancelling it must be honoured while it waits.
      const again = randomUUID();
      const queued = install(again);
      expect(await server.dispatch("tools.cancelInstall", { commandId: again })).toEqual({
        cancelled: true,
      });
      const { result } = await queued;
      expect((await cancelled).result).toMatchObject({ status: "failed", cancelled: true });
      expect(result).toMatchObject({ status: "failed", cancelled: true });
      // Only the first, cancelled brew ever ran.
      expect(runsOf(bin)).toBe(1);
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "a cancelled waiting retry starts nothing even when the dying run rejects",
    async () => {
      let probeBroken = false;
      const { server, events, bin } = await installer(
        `trap "" TERM; ${SLEEPING_BREW.replace("sleep 2", "sleep 3")}`,
        "exit 0",
        { probeThrows: () => probeBroken },
      );
      const install = (commandId: string) =>
        server.dispatch("tools.install", {
          tool: "git-lfs",
          locus: { kind: "host" },
          commandId,
        }) as Promise<CommandOutput<"tools.install">>;
      const first = randomUUID();
      const dying = install(first).catch((error: unknown) => error);
      await heard(events, first, "==> starting");
      // The dying run's re-probe throws, so its result rejects.
      probeBroken = true;
      expect(await server.dispatch("tools.cancelInstall", { commandId: first })).toEqual({
        cancelled: true,
      });
      const again = randomUUID();
      const queued = install(again).catch((error: unknown) => error);
      expect(await server.dispatch("tools.cancelInstall", { commandId: again })).toEqual({
        cancelled: true,
      });
      expect(await dying).toBeInstanceOf(Error);
      const answer = await queued;
      // Either a cancelled result or the probe's own error — never an install.
      if (!(answer instanceof Error)) {
        expect((answer as CommandOutput<"tools.install">).result).toMatchObject({
          status: "failed",
          cancelled: true,
        });
      }
      expect(runsOf(bin)).toBe(1);
    },
    30_000,
  );

  it("tools.cancelInstall says false when nothing by that id is running", async () => {
    const { server } = await installer("exit 0", "exit 0");
    expect(await server.dispatch("tools.cancelInstall", { commandId: randomUUID() })).toEqual({
      cancelled: false,
    });
  });
});
