import { describe, expect, it } from "vitest";
import { type LocusCommand, WSL_EXE } from "./locus";
import {
  buildWslHomeProbe,
  ensureWslBundleDelivered,
  parseWslHome,
  WslBundleDeliveryError,
  type WslRunResult,
  wslDaemonDataDir,
  wslServerBundlePath,
} from "./wsl-bundle";

// The cursor-shape escape an interactive login shell can prepend (see wsl-node).
const PROMPT_ESC = "\x1b[5 q";

describe("wslServerBundlePath", () => {
  it("builds the versioned distro-native entry path (index.cjs)", () => {
    expect(wslServerBundlePath("/home/rai", "0.3.12")).toBe(
      "/home/rai/.rennet/server/0.3.12/index.cjs",
    );
  });

  it("does not double the separator for a root-ish home", () => {
    expect(wslServerBundlePath("/root/", "1.0.0")).toBe("/root/.rennet/server/1.0.0/index.cjs");
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

  it("recovers the absolute home from multi-line output (a warning line must not collapse it)", () => {
    // The prior bug stripped \n before splitting, collapsing this to "/home/raiwarning".
    expect(parseWslHome("/home/rai\nwarning")).toBe("/home/rai");
    expect(parseWslHome("bash: warning\n/home/rai")).toBe("/home/rai");
  });
});

describe("ensureWslBundleDelivered", () => {
  const delivery = {
    distro: "Ubuntu",
    distroHome: "/home/rai",
    version: "0.3.12",
    hostBundlePath: "C:\\Users\\rai\\Rennet\\dist\\server\\index.cjs",
  };
  const targetDir = "/home/rai/.rennet/server/0.3.12";
  const entry = `${targetDir}/index.cjs`;
  const rootedAddon = `${targetDir}/native/linux-x64/rennet-rooted-landing.node`;
  const exclusiveMove = `${targetDir}/native/linux-x64/rennet-exclusive-move`;
  const completionMarker = `${targetDir}/.rennet-bundle-complete`;

  /** A fake runner: scripted results by index; THROWS on any unscripted call (mutation-sensitive). */
  function recorder(results: WslRunResult[]) {
    const calls: LocusCommand[] = [];
    const run = async (command: LocusCommand): Promise<WslRunResult> => {
      const result = results[calls.length];
      if (result === undefined) {
        throw new Error(
          `unscripted run() call #${calls.length + 1}: ${JSON.stringify(command.args)}`,
        );
      }
      calls.push(command);
      return result;
    };
    return { calls, run };
  }

  it("is a no-op when the complete Linux daemon payload and completion marker exist", async () => {
    const { calls, run } = recorder([
      { stdout: "", code: 0 }, // entry present
      { stdout: "", code: 0 }, // rooted addon present
      { stdout: "", code: 0 }, // exclusive move helper present
      { stdout: "", code: 0 }, // completion marker present
    ]);
    const result = await ensureWslBundleDelivered(delivery, run);

    expect(result).toBe(entry);
    expect(calls.map((call) => call.args)).toEqual([
      ["-d", "Ubuntu", "-e", "test", "-f", entry],
      ["-d", "Ubuntu", "-e", "test", "-f", rootedAddon],
      ["-d", "Ubuntu", "-e", "test", "-x", exclusiveMove],
      ["-d", "Ubuntu", "-e", "test", "-f", completionMarker],
    ]);
  });

  it("delivers the whole server directory and publishes the completion marker last", async () => {
    const { calls, run } = recorder([
      { stdout: "", code: 1 }, // test -f entry → absent
      { stdout: "", code: 0 }, // rm -f stale completion marker
      { stdout: "", code: 0 }, // mkdir -p targetDir
      { stdout: "/mnt/c/Users/rai/Rennet/dist/server/index.cjs\n", code: 0 }, // wslpath -u
      { stdout: "", code: 0 }, // cp -r <dir>/. targetDir
      { stdout: "", code: 0 }, // chmod 0755 exclusive move helper
      { stdout: "", code: 0 }, // verify test -f entry
      { stdout: "", code: 0 }, // verify rooted addon
      { stdout: "", code: 0 }, // verify executable exclusive move helper
      { stdout: "", code: 0 }, // touch completion marker
      { stdout: "", code: 0 }, // verify completion marker
    ]);
    const result = await ensureWslBundleDelivered(delivery, run);

    expect(result).toBe(entry);
    expect(calls.map((c) => c.args)).toEqual([
      ["-d", "Ubuntu", "-e", "test", "-f", entry],
      ["-d", "Ubuntu", "-e", "rm", "-f", completionMarker],
      ["-d", "Ubuntu", "-e", "mkdir", "-p", targetDir],
      ["-d", "Ubuntu", "-e", "wslpath", "-u", "C:\\Users\\rai\\Rennet\\dist\\server\\index.cjs"],
      ["-d", "Ubuntu", "-e", "cp", "-r", "/mnt/c/Users/rai/Rennet/dist/server/.", targetDir],
      ["-d", "Ubuntu", "-e", "chmod", "0755", exclusiveMove],
      ["-d", "Ubuntu", "-e", "test", "-f", entry],
      ["-d", "Ubuntu", "-e", "test", "-f", rootedAddon],
      ["-d", "Ubuntu", "-e", "test", "-x", exclusiveMove],
      ["-d", "Ubuntu", "-e", "touch", completionMarker],
      ["-d", "Ubuntu", "-e", "test", "-f", completionMarker],
    ]);
    expect(calls.every((c) => c.file === WSL_EXE)).toBe(true);
  });

  it("recopies when the entry exists but the Linux rooted addon is missing", async () => {
    const { calls, run } = recorder([
      { stdout: "", code: 0 }, // entry present
      { stdout: "", code: 1 }, // rooted addon absent
      { stdout: "", code: 0 }, // remove completion marker
      { stdout: "", code: 0 }, // mkdir
      { stdout: "/mnt/c/x/server/index.cjs\n", code: 0 }, // wslpath
      { stdout: "", code: 0 }, // cp
      { stdout: "", code: 0 }, // chmod
      { stdout: "", code: 0 }, // entry verified
      { stdout: "", code: 0 }, // rooted addon verified
      { stdout: "", code: 0 }, // executable exclusive move helper verified
      { stdout: "", code: 0 }, // completion marker created
      { stdout: "", code: 0 }, // completion marker verified
    ]);

    await expect(ensureWslBundleDelivered(delivery, run)).resolves.toBe(entry);
    expect(calls.map((call) => call.args.slice(3))).toEqual([
      ["test", "-f", entry],
      ["test", "-f", rootedAddon],
      ["rm", "-f", completionMarker],
      ["mkdir", "-p", targetDir],
      ["wslpath", "-u", delivery.hostBundlePath],
      ["cp", "-r", "/mnt/c/x/server/.", targetDir],
      ["chmod", "0755", exclusiveMove],
      ["test", "-f", entry],
      ["test", "-f", rootedAddon],
      ["test", "-x", exclusiveMove],
      ["touch", completionMarker],
      ["test", "-f", completionMarker],
    ]);
  });

  it("recopies when the entry and addon exist but the Linux exclusive move helper is missing", async () => {
    const { calls, run } = recorder([
      { stdout: "", code: 0 }, // entry present
      { stdout: "", code: 0 }, // rooted addon present
      { stdout: "", code: 1 }, // exclusive move helper absent or non-executable
      { stdout: "", code: 0 }, // remove completion marker
      { stdout: "", code: 0 }, // mkdir
      { stdout: "/mnt/c/x/server/index.cjs\n", code: 0 }, // wslpath
      { stdout: "", code: 0 }, // cp
      { stdout: "", code: 0 }, // chmod
      { stdout: "", code: 0 }, // entry verified
      { stdout: "", code: 0 }, // rooted addon verified
      { stdout: "", code: 0 }, // executable exclusive move helper verified
      { stdout: "", code: 0 }, // completion marker created
      { stdout: "", code: 0 }, // completion marker verified
    ]);

    await expect(ensureWslBundleDelivered(delivery, run)).resolves.toBe(entry);
    expect(calls.some((call) => call.args[3] === "cp")).toBe(true);
  });

  it("recopies when every payload file exists but the completion marker is missing", async () => {
    const { calls, run } = recorder([
      { stdout: "", code: 0 }, // entry present
      { stdout: "", code: 0 }, // rooted addon present
      { stdout: "", code: 0 }, // executable helper present
      { stdout: "", code: 1 }, // completion marker absent
      { stdout: "", code: 0 }, // remove stale marker path
      { stdout: "", code: 0 }, // mkdir
      { stdout: "/mnt/c/x/server/index.cjs\n", code: 0 }, // wslpath
      { stdout: "", code: 0 }, // cp
      { stdout: "", code: 0 }, // chmod
      { stdout: "", code: 0 }, // entry verified
      { stdout: "", code: 0 }, // rooted addon verified
      { stdout: "", code: 0 }, // executable helper verified
      { stdout: "", code: 0 }, // completion marker created
      { stdout: "", code: 0 }, // completion marker verified
    ]);

    await expect(ensureWslBundleDelivered(delivery, run)).resolves.toBe(entry);
    expect(calls.map((call) => call.args.slice(3))).toEqual([
      ["test", "-f", entry],
      ["test", "-f", rootedAddon],
      ["test", "-x", exclusiveMove],
      ["test", "-f", completionMarker],
      ["rm", "-f", completionMarker],
      ["mkdir", "-p", targetDir],
      ["wslpath", "-u", delivery.hostBundlePath],
      ["cp", "-r", "/mnt/c/x/server/.", targetDir],
      ["chmod", "0755", exclusiveMove],
      ["test", "-f", entry],
      ["test", "-f", rootedAddon],
      ["test", "-x", exclusiveMove],
      ["touch", completionMarker],
      ["test", "-f", completionMarker],
    ]);
  });

  it("throws before ANY command when distroHome is not absolute", async () => {
    const { calls, run } = recorder([]);
    await expect(
      ensureWslBundleDelivered({ ...delivery, distroHome: "" }, run),
    ).rejects.toBeInstanceOf(WslBundleDeliveryError);
    expect(calls).toHaveLength(0);
  });

  it("stops at any required-file probe failure (code neither 0 nor 1)", async () => {
    const { calls, run } = recorder([{ stdout: "", code: 2 }]);
    await expect(ensureWslBundleDelivered(delivery, run)).rejects.toBeInstanceOf(
      WslBundleDeliveryError,
    );
    expect(calls).toHaveLength(1);
  });

  it("stops AT mkdir when it fails", async () => {
    const { calls, run } = recorder([
      { stdout: "", code: 1 },
      { stdout: "", code: 0 },
      { stdout: "", code: 1 },
    ]);
    await expect(ensureWslBundleDelivered(delivery, run)).rejects.toBeInstanceOf(
      WslBundleDeliveryError,
    );
    expect(calls).toHaveLength(3);
  });

  it("stops AT wslpath when it exits nonzero, never issuing cp", async () => {
    const { calls, run } = recorder([
      { stdout: "", code: 1 },
      { stdout: "", code: 0 },
      { stdout: "", code: 0 },
      { stdout: "/mnt/c/x/server/index.cjs\n", code: 3 },
    ]);
    await expect(ensureWslBundleDelivered(delivery, run)).rejects.toBeInstanceOf(
      WslBundleDeliveryError,
    );
    expect(calls).toHaveLength(4);
  });

  it("stops AT wslpath when its output is non-absolute, never issuing cp", async () => {
    const { calls, run } = recorder([
      { stdout: "", code: 1 },
      { stdout: "", code: 0 },
      { stdout: "", code: 0 },
      { stdout: "wslpath: cannot access\n", code: 0 },
    ]);
    await expect(ensureWslBundleDelivered(delivery, run)).rejects.toBeInstanceOf(
      WslBundleDeliveryError,
    );
    expect(calls).toHaveLength(4);
  });

  it("throws AT cp when it fails (a failed copy is never reported as delivered)", async () => {
    const { calls, run } = recorder([
      { stdout: "", code: 1 },
      { stdout: "", code: 0 },
      { stdout: "", code: 0 },
      { stdout: "/mnt/c/x/server/index.cjs\n", code: 0 },
      { stdout: "", code: 1 }, // cp -r fails
    ]);
    await expect(ensureWslBundleDelivered(delivery, run)).rejects.toBeInstanceOf(
      WslBundleDeliveryError,
    );
    expect(calls).toHaveLength(5);
    expect(calls.map((call) => call.args.slice(3))).toContainEqual(["rm", "-f", completionMarker]);
    expect(calls.some((call) => call.args[3] === "touch")).toBe(false);
  });

  it("throws at chmod when the copied Linux helper cannot be made executable", async () => {
    const { calls, run } = recorder([
      { stdout: "", code: 1 },
      { stdout: "", code: 0 },
      { stdout: "", code: 0 },
      { stdout: "/mnt/c/x/server/index.cjs\n", code: 0 },
      { stdout: "", code: 0 },
      { stdout: "", code: 1 },
    ]);

    await expect(ensureWslBundleDelivered(delivery, run)).rejects.toThrow(exclusiveMove);
    expect(calls.at(-1)?.args.slice(3)).toEqual(["chmod", "0755", exclusiveMove]);
  });

  it("throws when the entry is missing after copy (partial delivery is not 'delivered')", async () => {
    const { calls, run } = recorder([
      { stdout: "", code: 1 }, // absent
      { stdout: "", code: 0 }, // remove completion marker
      { stdout: "", code: 0 }, // mkdir
      { stdout: "/mnt/c/x/server/index.cjs\n", code: 0 }, // wslpath
      { stdout: "", code: 0 }, // cp -r ok
      { stdout: "", code: 0 }, // chmod helper
      { stdout: "", code: 1 }, // verify test -f entry → MISSING
    ]);
    await expect(ensureWslBundleDelivered(delivery, run)).rejects.toBeInstanceOf(
      WslBundleDeliveryError,
    );
    expect(calls).toHaveLength(7);
  });

  it("throws when the rooted addon is missing after copy", async () => {
    const { calls, run } = recorder([
      { stdout: "", code: 1 },
      { stdout: "", code: 0 },
      { stdout: "", code: 0 },
      { stdout: "/mnt/c/x/server/index.cjs\n", code: 0 },
      { stdout: "", code: 0 },
      { stdout: "", code: 0 },
      { stdout: "", code: 0 },
      { stdout: "", code: 1 },
    ]);

    await expect(ensureWslBundleDelivered(delivery, run)).rejects.toThrow(rootedAddon);
    expect(calls).toHaveLength(8);
  });

  it("throws when the exclusive move helper is missing after copy", async () => {
    const { calls, run } = recorder([
      { stdout: "", code: 1 },
      { stdout: "", code: 0 },
      { stdout: "", code: 0 },
      { stdout: "/mnt/c/x/server/index.cjs\n", code: 0 },
      { stdout: "", code: 0 },
      { stdout: "", code: 0 },
      { stdout: "", code: 0 },
      { stdout: "", code: 0 },
      { stdout: "", code: 1 },
    ]);

    await expect(ensureWslBundleDelivered(delivery, run)).rejects.toThrow(exclusiveMove);
    expect(calls).toHaveLength(9);
  });

  it("removes a marker that cannot be verified after final creation", async () => {
    const { calls, run } = recorder([
      { stdout: "", code: 1 }, // entry absent
      { stdout: "", code: 0 }, // remove completion marker
      { stdout: "", code: 0 }, // mkdir
      { stdout: "/mnt/c/x/server/index.cjs\n", code: 0 }, // wslpath
      { stdout: "", code: 0 }, // cp
      { stdout: "", code: 0 }, // chmod
      { stdout: "", code: 0 }, // entry verified
      { stdout: "", code: 0 }, // rooted addon verified
      { stdout: "", code: 0 }, // executable helper verified
      { stdout: "", code: 0 }, // completion marker created
      { stdout: "", code: 1 }, // marker verification fails
      { stdout: "", code: 0 }, // failed marker removed
    ]);

    await expect(ensureWslBundleDelivered(delivery, run)).rejects.toThrow(completionMarker);
    expect(calls.at(-1)?.args.slice(3)).toEqual(["rm", "-f", completionMarker]);
  });
});
