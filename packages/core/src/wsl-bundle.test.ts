import { describe, expect, it } from "vitest";
import { type LocusCommand, WSL_EXE } from "./locus";
import {
  buildWslHomeProbe,
  ensureWslBundleDelivered,
  parseWslHome,
  type WslRunResult,
  wslDaemonDataDir,
  wslServerBundlePath,
} from "./wsl-bundle";

// The cursor-shape escape an interactive login shell can prepend (see wsl-node).
const PROMPT_ESC = "\x1b[5 q";

describe("wslServerBundlePath", () => {
  it("builds the versioned distro-native bundle path", () => {
    expect(wslServerBundlePath("/home/rai", "0.3.12")).toBe(
      "/home/rai/.rennet/server/0.3.12/rennet.cjs",
    );
  });

  it("does not double the separator for a root-ish home", () => {
    expect(wslServerBundlePath("/root/", "1.0.0")).toBe("/root/.rennet/server/1.0.0/rennet.cjs");
  });
});

describe("wslDaemonDataDir", () => {
  it("builds the distro-native data dir the daemon owns", () => {
    expect(wslDaemonDataDir("/home/rai")).toBe("/home/rai/.local/share/rennet");
  });
});

describe("buildWslHomeProbe", () => {
  it("probes $HOME via a login shell, byte-verbatim -e argv", () => {
    expect(buildWslHomeProbe("Ubuntu")).toEqual({
      file: WSL_EXE,
      args: ["-d", "Ubuntu", "-e", "sh", "-lc", 'printf %s "$HOME"'],
    });
  });
});

describe("parseWslHome", () => {
  it("returns the absolute home, stripping prompt/control noise", () => {
    expect(parseWslHome("/home/rai")).toBe("/home/rai");
    expect(parseWslHome(`${PROMPT_ESC}/home/rai\n`)).toBe("/home/rai");
  });

  it("rejects a non-absolute value", () => {
    expect(parseWslHome("")).toBe(null);
    expect(parseWslHome("HOME: unbound variable")).toBe(null);
  });
});

describe("ensureWslBundleDelivered", () => {
  const delivery = {
    distro: "Ubuntu",
    distroHome: "/home/rai",
    version: "0.3.12",
    hostBundlePath: "C:\\Users\\rai\\rennet\\rennet.cjs",
  };
  const target = "/home/rai/.rennet/server/0.3.12/rennet.cjs";

  /** A fake runner: records every command; returns scripted results by index. */
  function recorder(results: WslRunResult[]) {
    const calls: LocusCommand[] = [];
    const run = async (command: LocusCommand): Promise<WslRunResult> => {
      calls.push(command);
      return results[calls.length - 1] ?? { stdout: "", code: 0 };
    };
    return { calls, run };
  }

  it("is a no-op when the versioned bundle already exists", async () => {
    const { calls, run } = recorder([{ stdout: "", code: 0 }]); // test -f → present
    const result = await ensureWslBundleDelivered(delivery, run);

    expect(result).toBe(target);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ file: WSL_EXE, args: ["-d", "Ubuntu", "-e", "test", "-f", target] });
  });

  it("copies once when absent: test → mkdir → wslpath → cp", async () => {
    const { calls, run } = recorder([
      { stdout: "", code: 1 }, // test -f → absent
      { stdout: "", code: 0 }, // mkdir -p
      { stdout: "/mnt/c/Users/rai/rennet/rennet.cjs\n", code: 0 }, // wslpath -u
      { stdout: "", code: 0 }, // cp
    ]);
    const result = await ensureWslBundleDelivered(delivery, run);

    expect(result).toBe(target);
    expect(calls.map((c) => c.args)).toEqual([
      ["-d", "Ubuntu", "-e", "test", "-f", target],
      ["-d", "Ubuntu", "-e", "mkdir", "-p", "/home/rai/.rennet/server/0.3.12"],
      ["-d", "Ubuntu", "-e", "wslpath", "-u", "C:\\Users\\rai\\rennet\\rennet.cjs"],
      ["-d", "Ubuntu", "-e", "cp", "/mnt/c/Users/rai/rennet/rennet.cjs", target],
    ]);
    expect(calls.every((c) => c.file === WSL_EXE)).toBe(true);
  });
});
