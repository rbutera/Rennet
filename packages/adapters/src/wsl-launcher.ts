import { WSL_EXE } from "@rennet/core";

/**
 * The native WSL Claude launch prefix consumed by the Claude Agent SDK's
 * `executableArgs` option. The SDK spawns `pathToClaudeCodeExecutable` without a
 * shell and prepends these arguments to its own Claude argv, so every value stays a
 * discrete argv element all the way through `wsl.exe -e`.
 */
export interface WslClaudeLauncherInput {
  readonly distro: string;
  readonly distroClaudePath: string;
  readonly distroCwd?: string;
}

export interface WslClaudeExecutable {
  readonly pathToClaudeCodeExecutable: typeof WSL_EXE;
  readonly executableArgs: string[];
}

export function wslClaudeExecutable(input: WslClaudeLauncherInput): WslClaudeExecutable {
  const executableArgs = ["-d", input.distro];
  if (input.distroCwd !== undefined) executableArgs.push("--cd", input.distroCwd);
  executableArgs.push("-e", input.distroClaudePath);
  return { pathToClaudeCodeExecutable: WSL_EXE, executableArgs };
}
