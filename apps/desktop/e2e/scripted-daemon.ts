import { type ChildProcess, execFileSync, fork } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { makeTempDir, modelFreeEnv } from "./harness";

/**
 * The SCRIPTED daemon every hermetic launched-app proof runs against: the real production
 * server, bundled and forked with a scripted harness plan in place of a provider port. No
 * `claude`, no `codex`, no network — the seats answer from the plan file.
 *
 * It lives beside the specs rather than inside one because more than one proof needs it
 * (#681's owner loop, #548/#549's lens settlements) and a second copy of the bundle recipe
 * is a second thing to keep in step with the daemon entry point.
 */

/** `modelFreeEnv` plus the test Node's own bin dir on PATH, so a repo gate can run. */
export function gateCapableEnv(home: string): NodeJS.ProcessEnv {
  const environment = modelFreeEnv(home);
  const nodeBin = dirname(process.execPath);
  const npm = join(nodeBin, process.platform === "win32" ? "npm.cmd" : "npm");
  if (!existsSync(npm)) throw new Error(`npm is missing beside the test Node binary: ${npm}`);
  return {
    ...environment,
    PATH: [nodeBin, environment.PATH].filter(Boolean).join(delimiter),
  };
}

export async function startTestDaemon(options: {
  userData: string;
  home: string;
  planPath: string;
  /** Present BOTH providers from the one plan, so the Flagged dual seat really runs two
   *  seats. Off by default: the single-harness proofs depend on the other being absent. */
  dualSeat?: boolean;
}): Promise<ChildProcess> {
  const desktopPackage: unknown = JSON.parse(
    readFileSync(resolve("apps/desktop/package.json"), "utf8"),
  );
  if (
    typeof desktopPackage !== "object" ||
    desktopPackage === null ||
    !("version" in desktopPackage) ||
    typeof desktopPackage.version !== "string"
  ) {
    throw new Error("apps/desktop/package.json has no version");
  }
  const bundleRoot = makeTempDir("rennet-e2e-scripted-daemon-");
  const bundlePath = join(bundleRoot, "scripted-daemon.cjs");
  execFileSync(resolve("node_modules/esbuild/bin/esbuild"), [
    resolve("apps/desktop/e2e/owner-loop-685-daemon.ts"),
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--target=node24",
    "--external:electron",
    "--external:@anthropic-ai/claude-agent-sdk",
    "--define:import.meta.url=__rennetBundledImportMetaUrl",
    '--banner:js=const __rennetBundledImportMetaUrl = require("node:url").pathToFileURL(__filename).href;',
    `--outfile=${bundlePath}`,
    "--log-level=warning",
  ]);
  cpSync(resolve("packages/prompts/src/prompts"), join(bundleRoot, "prompts"), {
    recursive: true,
  });
  cpSync(resolve("packages/server/dist/native"), join(bundleRoot, "native"), {
    recursive: true,
  });
  const child = fork(bundlePath, [], {
    cwd: resolve("."),
    env: {
      ...gateCapableEnv(options.home),
      RENNET_USER_DATA: options.userData,
      RENNET_OWNER_LOOP_PLAN: options.planPath,
      RENNET_SERVER_VERSION: desktopPackage.version,
      ...(options.dualSeat === true ? { RENNET_SCRIPTED_DUAL_SEAT: "1" } : {}),
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  await new Promise<void>((resolveReady, rejectReady) => {
    child.once("message", resolveReady);
    child.once("error", rejectReady);
    child.once("exit", (code) => rejectReady(new Error(`test daemon exited ${code}: ${stderr}`)));
  });
  child.once("exit", () => rmSync(bundleRoot, { recursive: true, force: true }));
  return child;
}
