import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { query, type SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { wslClaudeExecutable } from "./wsl-launcher";

describe("wslClaudeExecutable", () => {
  it("points the SDK directly at wsl.exe with the distro command as prepended argv", () => {
    expect(
      wslClaudeExecutable({
        distro: "Ubuntu",
        distroClaudePath: "/home/rai/.local/bin/claude",
        distroCwd: "/home/rai/my repo",
      }),
    ).toEqual({
      pathToClaudeCodeExecutable: "wsl.exe",
      executableArgs: [
        "-d",
        "Ubuntu",
        "--cd",
        "/home/rai/my repo",
        "-e",
        "/home/rai/.local/bin/claude",
      ],
    });
  });

  it("omits --cd when the caller has no repo cwd", () => {
    expect(
      wslClaudeExecutable({ distro: "Ubuntu", distroClaudePath: "/usr/local/bin/claude" }),
    ).toEqual({
      pathToClaudeCodeExecutable: "wsl.exe",
      executableArgs: ["-d", "Ubuntu", "-e", "/usr/local/bin/claude"],
    });
  });

  it("reaches the SDK spawn effect with byte-verbatim complex argv and no cmd interpreter", () => {
    const executable = wslClaudeExecutable({
      distro: "Ubuntu Dev",
      distroClaudePath: "/home/rai/tools with spaces/claude",
      distroCwd: "/home/rai/repo with spaces",
    });
    const complex = {
      space: "two words",
      quote: "a\"b'c",
      percent: "100%",
      dollar: "$HOME",
      ampersand: "a&b",
      json: JSON.stringify({ message: 'hello "世界"', amount: "50% & $5" }),
      unicode: "café/雪",
    };
    let spawnCommand: string | undefined;
    let spawnArgs: string[] | undefined;
    const transport = query({
      prompt: "probe",
      options: {
        cwd: "C:\\Users\\rai\\AppData\\Local\\Temp",
        ...executable,
        extraArgs: complex,
        spawnClaudeCodeProcess: (options) => {
          spawnCommand = options.command;
          spawnArgs = options.args;
          return fakeProcess();
        },
      },
    });

    expect(spawnCommand).toBe("wsl.exe");
    expect(spawnArgs).toEqual([
      "-d",
      "Ubuntu Dev",
      "--cd",
      "/home/rai/repo with spaces",
      "-e",
      "/home/rai/tools with spaces/claude",
      "--output-format",
      "stream-json",
      "--verbose",
      "--input-format",
      "stream-json",
      "--permission-mode",
      "default",
      ...Object.entries(complex).flatMap(([key, value]) => [`--${key}`, value]),
    ]);
    expect(spawnArgs).not.toContain("cmd.exe");
    expect(spawnArgs).not.toContain("/c");
    transport.close();
  });
});

function fakeProcess(): SpawnedProcess {
  const events = new EventEmitter();
  return {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    killed: false,
    exitCode: null,
    signalCode: null,
    kill: () => true,
    on: events.on.bind(events) as SpawnedProcess["on"],
    once: events.once.bind(events) as SpawnedProcess["once"],
    off: events.off.bind(events) as SpawnedProcess["off"],
  };
}
