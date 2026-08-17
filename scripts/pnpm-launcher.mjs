import { deepStrictEqual, strictEqual } from "node:assert";

// Node (post CVE-2024-27980) refuses to spawn a `.cmd`/`.bat` without a shell, so on
// Windows a bare spawnSync("pnpm.cmd", …) EINVALs. Route through the command processor
// explicitly on win32: fixed literal tokens plus the caller's argv, each element passed
// separately (never concatenated into a shell string), so there is nothing to escape and
// no interpolation from variable data. On every other platform "pnpm" spawns directly.
//
// `platform` is a parameter (defaulting to the ambient one) so the win32 branch is
// exercisable off Windows — that is what assertPnpmCommandShape() below proves.
export function pnpmCommand(args, platform = process.platform) {
  if (platform === "win32") {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", "pnpm", ...args],
    };
  }
  return { command: "pnpm", args };
}

// Runtime positive control, same idiom as the licence/boundary gates: prove the
// platform-keyed construction on every invocation (including macOS/Linux CI), so a
// regression in the win32 branch fails the gate without needing a Windows host. Real
// Windows execution is verified separately on the win32 matrix.
export function assertPnpmCommandShape() {
  const posix = pnpmCommand(["licenses", "list"], "linux");
  strictEqual(posix.command, "pnpm");
  deepStrictEqual(posix.args, ["licenses", "list"]);

  // A path with a space stays a single argv element under the win32 branch.
  const win = pnpmCommand(["exec", "eslint", "C:\\a b\\ctrl.ts"], "win32");
  strictEqual(win.command, process.env.ComSpec ?? "cmd.exe");
  deepStrictEqual(win.args, ["/d", "/s", "/c", "pnpm", "exec", "eslint", "C:\\a b\\ctrl.ts"]);
}
