import { describe, expect, it } from "vitest";
import { checkpointGitCommand } from "./checkpoint-store";

const WSL = { kind: "wsl", distro: "Ubuntu" } as const;
const HOST = { kind: "host" } as const;

describe("checkpointGitCommand", () => {
  it("host: plain git in cwd, no env when no index file", () => {
    const cmd = checkpointGitCommand(HOST, "/repo", ["write-tree"]);
    expect(cmd).toEqual({ file: "git", args: ["write-tree"], cwd: "/repo" });
  });

  it("host: GIT_INDEX_FILE rides in execa env", () => {
    const cmd = checkpointGitCommand(HOST, "/repo", ["add", "-A"], "/tmp/x.index");
    expect(cmd.file).toBe("git");
    expect(cmd.args).toEqual(["add", "-A"]);
    expect(cmd.env?.GIT_INDEX_FILE).toBe("/tmp/x.index");
  });

  it("wsl: the index var is injected in-distro via an `env` prefix, never execa env", () => {
    const cmd = checkpointGitCommand(
      WSL,
      "\\\\wsl.localhost\\Ubuntu\\home\\rai\\repo",
      ["add", "-A"],
      "/tmp/rennet.index",
    );
    expect(cmd.file).toBe("wsl.exe");
    expect(cmd.args).toEqual([
      "-d",
      "Ubuntu",
      "--cd",
      "/home/rai/repo",
      "-e",
      "env",
      "GIT_INDEX_FILE=/tmp/rennet.index",
      "git",
      "add",
      "-A",
    ]);
    // The var must NOT be handed to execa's env — it would not cross the boundary.
    expect(cmd.env).toBeUndefined();
  });

  it("wsl: plain git (no index) uses the -e form", () => {
    const cmd = checkpointGitCommand(WSL, "/home/rai/repo", ["update-ref", "-d", "refs/x"]);
    expect(cmd.args).toEqual([
      "-d",
      "Ubuntu",
      "--cd",
      "/home/rai/repo",
      "-e",
      "git",
      "update-ref",
      "-d",
      "refs/x",
    ]);
  });
});
