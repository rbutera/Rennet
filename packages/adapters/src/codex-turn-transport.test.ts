import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locus } from "@rennet/core";
import { describe, expect, it } from "vitest";
import type { CodexTurnResultFrame, CodexTurnSpec } from "./codex-adapter";
import {
  type CodexTransportEffects,
  createCodexTurnTransport,
  defaultCodexTransportEffects,
} from "./codex-turn-transport";

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

// ── Locus-aware argv/path composition (#334), hermetic (no real wsl.exe) ────────

interface SpawnCall {
  readonly bin: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
  readonly outPath: string;
}

function fakeEffects(): {
  effects: CodexTransportEffects;
  spawns: SpawnCall[];
  writes: { path: string; data: string }[];
  rms: string[];
  mints: string[];
} {
  const spawns: SpawnCall[] = [];
  const writes: { path: string; data: string }[] = [];
  const rms: string[] = [];
  const mints: string[] = [];
  const effects: CodexTransportEffects = {
    mkdtemp: async (prefix) => `${prefix}host-scratch`,
    mintDistroScratch: async (distro) => {
      mints.push(distro);
      return "/tmp/distro-scratch";
    },
    writeFile: async (path, data) => {
      writes.push({ path, data });
    },
    readFile: async () => "",
    rm: async (path) => {
      rms.push(path);
    },
    spawn: (bin, args, cwd, outPath) => ({
      async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
        spawns.push({ bin, args, cwd, outPath });
        yield {
          rennet: "turn-result",
          exitCode: 0,
          lastMessage: null,
        } satisfies CodexTurnResultFrame;
      },
    }),
  };
  return { effects, spawns, writes, rms, mints };
}

async function drive(transport: ReturnType<typeof createCodexTurnTransport>, spec: CodexTurnSpec) {
  for await (const frame of transport(spec)) {
    void frame; // drain to the terminal frame
  }
}

describe("Codex transport locus composition", () => {
  const spec: CodexTurnSpec = {
    cwd: "\\\\wsl.localhost\\Ubuntu\\home\\rai\\repo",
    prompt: "review this",
    outputSchema: { type: "object" },
  };

  it("host locus spawns codex directly with host-native argv and cwd", async () => {
    const { effects, spawns, writes } = fakeEffects();
    const hostSpec: CodexTurnSpec = { ...spec, cwd: "/home/rai/repo" };
    await drive(createCodexTurnTransport("codex", effects), hostSpec);

    expect(spawns).toHaveLength(1);
    const call = spawns[0] as SpawnCall;
    expect(call.bin).toBe("codex");
    expect(call.cwd).toBe("/home/rai/repo");
    // -C is the real repo; -o and --output-schema live in the host scratch dir.
    expect(call.args).toContain("-C");
    expect(call.args[call.args.indexOf("-C") + 1]).toBe("/home/rai/repo");
    // -o and the read-back path are the SAME host scratch path (no UNC translation).
    expect(call.outPath).toBe(call.args[call.args.indexOf("-o") + 1]);
    expect(call.outPath).toContain("host-scratch");
    expect(call.outPath.endsWith("last-message.txt")).toBe(true);
    // The schema was written to the same host path codex reads it from.
    expect(writes[0]?.path).toContain("host-scratch");
    expect(call.args).toContain(writes[0]?.path);
  });

  it("wsl locus wraps the spawn in wsl.exe with distro-native argv and UNC io", async () => {
    const { effects, spawns, writes, rms } = fakeEffects();
    const locus: Locus = { kind: "wsl", distro: "Ubuntu" };
    await drive(createCodexTurnTransport("codex", effects, locus), spec);

    expect(spawns).toHaveLength(1);
    const call = spawns[0] as SpawnCall;
    // The spawn is wsl.exe -d Ubuntu --cd <distro repo> -e codex …; cwd rides --cd.
    expect(call.bin).toBe("wsl.exe");
    expect(call.cwd).toBeUndefined();
    expect(call.args.slice(0, 2)).toEqual(["-d", "Ubuntu"]);
    expect(call.args).toContain("--cd");
    expect(call.args[call.args.indexOf("--cd") + 1]).toBe("/home/rai/repo");
    expect(call.args).toContain("-e");
    expect(call.args[call.args.indexOf("-e") + 1]).toBe("codex");
    // -C is the distro-native repo path (not the UNC path).
    expect(call.args[call.args.indexOf("-C") + 1]).toBe("/home/rai/repo");
    // -o and --output-schema are distro-native paths under the distro scratch.
    expect(call.args[call.args.indexOf("-o") + 1]).toBe("/tmp/distro-scratch/last-message.txt");
    expect(call.args[call.args.indexOf("--output-schema") + 1]).toBe(
      "/tmp/distro-scratch/schema.json",
    );
    // The Windows side does its IO through the UNC view of the same dir.
    expect(call.outPath).toBe("\\\\wsl.localhost\\Ubuntu\\tmp\\distro-scratch\\last-message.txt");
    expect(writes[0]?.path).toBe("\\\\wsl.localhost\\Ubuntu\\tmp\\distro-scratch\\schema.json");
    expect(rms[0]).toBe("\\\\wsl.localhost\\Ubuntu\\tmp\\distro-scratch");
  });

  it("wsl locus with an untranslatable repo path fails before any scratch mint or spawn", async () => {
    // A `C:\` repo pinned to a WSL locus is untranslatable; the turn must fail plainly
    // naming the path and distro — never mint distro scratch, never spawn, never fall
    // back to the host path (Codex FAIL #1: the old `?? spec.cwd` host fallback).
    const { effects, spawns, mints, rms } = fakeEffects();
    const locus: Locus = { kind: "wsl", distro: "Ubuntu" };
    const untranslatable: CodexTurnSpec = { ...spec, cwd: "C:\\Users\\rai\\repo" };
    await expect(
      drive(createCodexTurnTransport("codex", effects, locus), untranslatable),
    ).rejects.toThrow(/not translatable.*Ubuntu|Ubuntu.*not translatable/s);
    expect(spawns).toHaveLength(0);
    expect(mints).toHaveLength(0);
    expect(rms).toHaveLength(0);
  });

  it("wsl locus launches an asdf codex through its paired node inside the -e argv", async () => {
    // A codex JS launcher under an asdf node install has no `node` on the distro's
    // non-interactive PATH, so discovery pairs its sibling node; the transport must
    // launch `… -e <node> <codex> exec …` (runtime + script both verbatim after -e).
    const { effects, spawns } = fakeEffects();
    const locus: Locus = { kind: "wsl", distro: "Ubuntu" };
    const codex = "/home/rai/.asdf/installs/nodejs/24.16.0/bin/codex";
    const node = "/home/rai/.asdf/installs/nodejs/24.16.0/bin/node";
    await drive(createCodexTurnTransport(codex, effects, locus, node), spec);

    expect(spawns).toHaveLength(1);
    const call = spawns[0] as SpawnCall;
    expect(call.bin).toBe("wsl.exe");
    const e = call.args.indexOf("-e");
    expect(call.args[e + 1]).toBe(node); // the paired runtime, verbatim
    expect(call.args[e + 2]).toBe(codex); // the codex launcher, verbatim
    expect(call.args[e + 3]).toBe("exec");
    // Paths stay distro-native and the codex path is never invoked bare.
    expect(call.args[call.args.indexOf("-C") + 1]).toBe("/home/rai/repo");
  });

  it("host locus without a paired runtime spawns codex directly (byte-identical)", async () => {
    const { effects, spawns } = fakeEffects();
    const hostSpec: CodexTurnSpec = { ...spec, cwd: "/home/rai/repo" };
    await drive(createCodexTurnTransport("codex", effects), hostSpec);
    const call = spawns[0] as SpawnCall;
    expect(call.bin).toBe("codex");
    expect(call.args[0]).toBe("exec");
  });
});
