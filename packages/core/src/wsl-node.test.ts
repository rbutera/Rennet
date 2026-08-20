import { describe, expect, it } from "vitest";
import { WSL_EXE } from "./locus";
import {
  buildWslDaemonLaunch,
  buildWslLoginShellProbe,
  buildWslNodeProbe,
  parseLoginShell,
  parseWslNodePath,
  resolveWslNode,
  WslNodeNotFoundError,
} from "./wsl-node";

// The exact cursor-shape escape an interactive shell prepends onto the captured
// stream (observed live on lancelot): ESC [ 5 SP q.
const PROMPT_ESC = "\x1b[5 q";

describe("parseLoginShell", () => {
  it("reads the shell path, stripping prompt/control noise", () => {
    expect(parseLoginShell("/home/linuxbrew/.linuxbrew/bin/zsh\n")).toBe(
      "/home/linuxbrew/.linuxbrew/bin/zsh",
    );
    expect(parseLoginShell(`${PROMPT_ESC}/bin/bash`)).toBe("/bin/bash");
  });

  it("falls back to /bin/sh when the output is not an absolute shell path", () => {
    expect(parseLoginShell("")).toBe("/bin/sh");
    expect(parseLoginShell("getent: command not found")).toBe("/bin/sh");
  });
});

describe("parseWslNodePath", () => {
  it("extracts the real binary even behind interactive prompt escapes", () => {
    const raw = `${PROMPT_ESC}/home/rai/.asdf/installs/nodejs/24.16.0/bin/node`;
    expect(parseWslNodePath(raw)).toBe("/home/rai/.asdf/installs/nodejs/24.16.0/bin/node");
  });

  it("takes the LAST node token when the shell emits surrounding noise", () => {
    expect(parseWslNodePath("[job 1]\n/usr/local/bin/node\n")).toBe("/usr/local/bin/node");
  });

  it("returns null when no node path is present", () => {
    expect(parseWslNodePath("zsh: command not found: node")).toBeNull();
    expect(parseWslNodePath("")).toBeNull();
  });
});

describe("probe argv (byte-verbatim -e form)", () => {
  it("login-shell probe runs sh -lc getent under wsl.exe -e", () => {
    const cmd = buildWslLoginShellProbe("Ubuntu");
    expect(cmd.file).toBe(WSL_EXE);
    expect(cmd.args).toEqual([
      "-d",
      "Ubuntu",
      "-e",
      "sh",
      "-lc",
      'getent passwd "$(id -un)" | cut -d: -f7',
    ]);
  });

  it("node probe runs the login shell INTERACTIVELY (-ic), not -lc", () => {
    const cmd = buildWslNodeProbe("Ubuntu", "/usr/bin/zsh");
    expect(cmd.args).toEqual([
      "-d",
      "Ubuntu",
      "-e",
      "/usr/bin/zsh",
      "-ic",
      "node -e 'process.stdout.write(process.execPath)'",
    ]);
  });
});

describe("buildWslDaemonLaunch", () => {
  it("builds the wsl.exe -e <node> <bundle> serve --data-dir descriptor", () => {
    const cmd = buildWslDaemonLaunch({
      distro: "Ubuntu",
      nodePath: "/home/u/.asdf/installs/nodejs/24.16.0/bin/node",
      bundlePath: "/home/u/.rennet/server/1.2.3/rennet.cjs",
      dataDir: "/home/u/.local/share/rennet",
      serverVersion: "1.2.3",
    });
    expect(cmd.file).toBe(WSL_EXE);
    expect(cmd.args).toEqual([
      "-d",
      "Ubuntu",
      "-e",
      "/home/u/.asdf/installs/nodejs/24.16.0/bin/node",
      "/home/u/.rennet/server/1.2.3/rennet.cjs",
      "serve",
      "--data-dir",
      "/home/u/.local/share/rennet",
      "--server-version",
      "1.2.3",
    ]);
  });

  it("omits optional flags when unset", () => {
    const cmd = buildWslDaemonLaunch({
      distro: "Debian",
      nodePath: "/usr/bin/node",
      bundlePath: "/opt/rennet.cjs",
      dataDir: "/data",
    });
    expect(cmd.args).not.toContain("--server-version");
    expect(cmd.args).not.toContain("--ui-dist");
  });
});

describe("resolveWslNode", () => {
  it("probes shell then node, returning the resolved binary", async () => {
    const seen: string[][] = [];
    const run = async (cmd: { args: readonly string[] }): Promise<string> => {
      seen.push([...cmd.args]);
      return seen.length === 1
        ? "/usr/bin/zsh\n"
        : `${PROMPT_ESC}/home/u/.asdf/installs/nodejs/24.16.0/bin/node`;
    };
    const node = await resolveWslNode("Ubuntu", run);
    expect(node).toBe("/home/u/.asdf/installs/nodejs/24.16.0/bin/node");
    expect(seen[1]).toContain("/usr/bin/zsh");
    expect(seen[1]).toContain("-ic");
  });

  it("throws WslNodeNotFoundError when the distro has no node", async () => {
    const run = async (): Promise<string> => "";
    await expect(resolveWslNode("Ubuntu", run)).rejects.toBeInstanceOf(WslNodeNotFoundError);
  });
});
