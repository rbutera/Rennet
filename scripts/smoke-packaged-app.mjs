import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  // RunAsNode is ENABLED (#379): the detached daemon runs the Electron binary as Node.
  "RunAsNode is Enabled",
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
let daemonPid;
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

  // The bundled-daemon proof (#379): the packaged app spawns its detached daemon from the
  // un-asar'd bundle with no system Node. Poll for the claim it publishes, then confirm its
  // health endpoint answers with matching versions — the daemon actually reached healthy.
  const claim = await pollClaim(join(userData, "daemon.json"), 15_000);
  const health = await fetch(`http://127.0.0.1:${claim.wsPort}/healthz`).then((r) => r.json());
  if (health.protocolVersion !== claim.protocolVersion || health.pid !== claim.pid) {
    throw new Error(`Daemon healthz mismatch: ${JSON.stringify({ claim, health })}`);
  }
  daemonPid = claim.pid;

  console.log(
    `Packaged app signature, fuse policy, launch, and bundled-daemon health smoke passed (daemon pid ${claim.pid}, port ${claim.wsPort}).`,
  );
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
  // The daemon OUTLIVES the app (the feature) — the smoke must stop it explicitly, or it
  // orphans under the throwaway user-data dir.
  if (daemonPid !== undefined) {
    try {
      process.kill(daemonPid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  rmSync(userData, { recursive: true, force: true });
}

/** Poll for the daemon's claim file to appear and parse, up to `timeoutMs`. */
async function pollClaim(claimPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return JSON.parse(readFileSync(claimPath, "utf8"));
    } catch {
      if (Date.now() >= deadline) throw new Error(`daemon.json never appeared at ${claimPath}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}
