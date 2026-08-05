import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

const appPath = resolve(process.argv[2] ?? "");
const executablePath = join(appPath, "Contents", "MacOS", basename(appPath, ".app"));
const userData = mkdtempSync(join(tmpdir(), "rennet-package-smoke-"));

execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], {
  stdio: "inherit",
});

const fuses = execFileSync("pnpm", ["exec", "electron-fuses", "read", "--app", appPath], {
  encoding: "utf8",
});
process.stdout.write(fuses);
const plainFuses = stripVTControlCharacters(fuses);

for (const expected of [
  "RunAsNode is Disabled",
  "EnableCookieEncryption is Enabled",
  "EnableNodeOptionsEnvironmentVariable is Disabled",
  "EnableNodeCliInspectArguments is Disabled",
  "EnableEmbeddedAsarIntegrityValidation is Enabled",
  "OnlyLoadAppFromAsar is Enabled",
  "GrantFileProtocolExtraPrivileges is Disabled",
  "WasmTrapHandlers is Enabled",
]) {
  if (!plainFuses.includes(expected)) {
    throw new Error(`Packaged app fuse mismatch: expected ${expected}`);
  }
}

const child = spawn(executablePath, [], {
  env: { ...process.env, RENNET_USER_DATA: userData },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  output += chunk.toString();
});

try {
  const outcome = await Promise.race([
    new Promise((resolveOutcome) => {
      child.once("exit", (code, signal) => resolveOutcome({ code, signal }));
    }),
    new Promise((resolveOutcome) => {
      setTimeout(() => resolveOutcome("running"), 2_500);
    }),
  ]);

  if (outcome !== "running") {
    throw new Error(
      `Packaged app exited before the smoke window: ${JSON.stringify(outcome)}\n${output}`,
    );
  }

  console.log("Packaged app signature, fuse policy, and launch smoke passed.");
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveExit) => {
      setTimeout(() => {
        child.kill("SIGKILL");
        resolveExit(undefined);
      }, 2_000);
    }),
  ]);
  rmSync(userData, { recursive: true, force: true });
}
