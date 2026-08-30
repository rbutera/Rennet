import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

const require = createRequire(import.meta.url);
const asar = require("@electron/asar");
const rootedProbeBytes = Buffer.from("installed rooted addon probe\n");
const moveProbeBytes = Buffer.from("installed exclusive move probe\n");

const updateLifecycleFragments = {
  autoUpdate: [
    "ipcMain.on(UPDATE_APPLY_CHANNEL",
    'phase = "applying";',
    "APPLY_HANDOFF_TIMEOUT_MS",
    "cancelRelaunchAfterApply = armRelaunchAfterApply();",
    "await recoverAfterApplyFailure();",
    "/usr/libexec/PlistBuddy",
    'exec "$opener" "$app_path"',
    'autoUpdater.on("update-available"',
    'autoUpdater.on("error", (error) => void handleUpdaterError(error))',
  ],
  main: [
    "prepareToApply: () => prepareOwnedDaemonForUpdate(dataDir)",
    "armRelaunchAfterApply:",
    "armMacUpdateRelaunch(",
    "recoverAfterApplyFailure: async () => {",
    "activeWsPort = await ensureDaemon(dataDir);",
    "await ensureWindowShared();",
    "applyUpdate: () => void update?.applyUpdate()",
  ],
};

export function verifyPackagedUpdateLifecycleSources(sources) {
  for (const [sourceName, fragments] of Object.entries(updateLifecycleFragments)) {
    const source = sources[sourceName];
    if (typeof source !== "string") {
      throw new Error(`Packaged updater source is missing: ${sourceName}`);
    }
    for (const fragment of fragments) {
      if (!source.includes(fragment)) {
        throw new Error(`Packaged updater lifecycle is incomplete in ${sourceName}: ${fragment}`);
      }
    }
  }
}

export function verifyPackagedUpdateLifecycle(
  appPath,
  { readArchiveFile = (archivePath, entryPath) => asar.extractFile(archivePath, entryPath) } = {},
) {
  const archivePath = join(resolve(appPath), "Contents", "Resources", "app.asar");
  const mapBytes = readArchiveFile(archivePath, "dist/main/index.cjs.map");
  const sourceMap = JSON.parse(Buffer.from(mapBytes).toString("utf8"));
  if (!Array.isArray(sourceMap.sources) || !Array.isArray(sourceMap.sourcesContent)) {
    throw new Error(`Packaged main source map is invalid: ${archivePath}`);
  }
  const sourceEndingWith = (ending) => {
    const index = sourceMap.sources.findIndex((source) => source.endsWith(ending));
    return index < 0 ? undefined : sourceMap.sourcesContent[index];
  };
  const sources = {
    autoUpdate: sourceEndingWith("/src/main/auto-update.ts"),
    main: sourceEndingWith("/src/main/index.ts"),
  };
  verifyPackagedUpdateLifecycleSources(sources);
  return { archivePath, sources };
}

export function installedNativePayloadPaths(
  appPath,
  { platform = process.platform, arch = process.arch } = {},
) {
  const nativeRoot = join(
    resolve(appPath),
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "dist",
    "server",
    "native",
    `${platform}-${arch}`,
  );
  return {
    nativeRoot,
    rootedAddonPath: join(nativeRoot, "rennet-rooted-landing.node"),
    exclusiveMovePath: join(
      nativeRoot,
      platform === "win32" ? "rennet-exclusive-move.exe" : "rennet-exclusive-move",
    ),
  };
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function defaultRunExclusiveMove({ helperPath, sourcePath, destinationPath }) {
  execFileSync(helperPath, [sourcePath, destinationPath], {
    stdio: "pipe",
    windowsHide: true,
  });
}

function verifyRootedAddon({
  binding,
  rootedAddonPath,
  platform,
  sourceRoot,
  workerRoot,
  infoRoot,
}) {
  if (!isRecord(binding) || typeof binding.RootedLandingHost !== "function") {
    throw new Error(`Packaged rooted landing addon is invalid: ${rootedAddonPath}`);
  }

  const RootedLandingHost = binding.RootedLandingHost;
  const constructorArguments = [sourceRoot, workerRoot, join(infoRoot, "exclude")];
  if (platform === "win32") {
    let host;
    try {
      host = new RootedLandingHost(...constructorArguments);
    } catch (error) {
      if (error instanceof Error && /unsupported on Windows/.test(error.message)) return;
      throw error;
    }
    try {
      throw new Error(
        `Packaged rooted landing addon did not report its current Windows limitation: ${rootedAddonPath}`,
      );
    } finally {
      if (isRecord(host) && typeof host.close === "function") host.close();
    }
  }

  let host;
  try {
    host = new RootedLandingHost(...constructorArguments);
    if (!isRecord(host) || typeof host.inspect !== "function" || typeof host.close !== "function") {
      throw new Error(`Packaged rooted landing addon returned an invalid host: ${rootedAddonPath}`);
    }
    const inspection = host.inspect("source", "probe.txt");
    const descriptor =
      isRecord(inspection) &&
      Number.isSafeInteger(inspection.descriptor) &&
      inspection.descriptor >= 0
        ? inspection.descriptor
        : undefined;
    try {
      if (
        !isRecord(inspection) ||
        inspection.kind !== "regular" ||
        descriptor === undefined ||
        typeof inspection.executable !== "boolean"
      ) {
        throw new Error(
          `Packaged rooted landing addon did not inspect a regular file: ${rootedAddonPath}`,
        );
      }
      if (!readFileSync(descriptor).equals(rootedProbeBytes)) {
        throw new Error(
          `Packaged rooted landing addon read the wrong file snapshot: ${rootedAddonPath}`,
        );
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  } finally {
    if (isRecord(host) && typeof host.close === "function") host.close();
  }
}

export function verifyInstalledNativePayload(
  appPath,
  {
    platform = process.platform,
    arch = process.arch,
    loadAddon = (addonPath) => require(addonPath),
    runExclusiveMove = defaultRunExclusiveMove,
  } = {},
) {
  const paths = installedNativePayloadPaths(appPath, { platform, arch });
  const scratchRoot = mkdtempSync(
    join(realpathSync(tmpdir()), "rennet-installed-native-payload-smoke-"),
  );
  const sourceRoot = join(scratchRoot, "source");
  const workerRoot = join(scratchRoot, "worker");
  const infoRoot = join(scratchRoot, "git-info");
  const sourcePath = join(scratchRoot, "move-source");
  const destinationPath = join(scratchRoot, "move-destination");

  try {
    mkdirSync(sourceRoot);
    mkdirSync(workerRoot);
    mkdirSync(infoRoot);
    writeFileSync(join(sourceRoot, "probe.txt"), rootedProbeBytes);

    verifyRootedAddon({
      binding: loadAddon(paths.rootedAddonPath),
      rootedAddonPath: paths.rootedAddonPath,
      platform,
      sourceRoot,
      workerRoot,
      infoRoot,
    });

    writeFileSync(sourcePath, moveProbeBytes);
    runExclusiveMove({
      helperPath: paths.exclusiveMovePath,
      sourcePath,
      destinationPath,
    });
    if (existsSync(sourcePath)) {
      throw new Error(
        `Packaged exclusive move helper left its source in place: ${paths.exclusiveMovePath}`,
      );
    }
    let movedBytes;
    try {
      movedBytes = readFileSync(destinationPath);
    } catch (error) {
      throw new Error(
        `Packaged exclusive move helper did not create its destination: ${paths.exclusiveMovePath}`,
        { cause: error },
      );
    }
    if (!movedBytes.equals(moveProbeBytes)) {
      throw new Error(
        `Packaged exclusive move helper moved the wrong bytes: ${paths.exclusiveMovePath}`,
      );
    }

    return paths;
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
}

export async function smokePackagedApp(appPathInput) {
  const appPath = resolve(appPathInput);
  const executablePath = join(appPath, "Contents", "MacOS", basename(appPath, ".app"));

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

  const nativePayload = verifyInstalledNativePayload(appPath);
  verifyPackagedUpdateLifecycle(appPath);
  const userData = mkdtempSync(join(tmpdir(), "rennet-package-smoke-"));

  // An inherited ELECTRON_RUN_AS_NODE=1 (any shell whose parent is itself an Electron
  // app exports it) would run the packaged binary as bare Node instead of launching the
  // app, so the smoke would fail on the environment rather than on the artifact (#569).
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...inheritedEnv } = process.env;
  const child = spawn(executablePath, [], {
    env: { ...inheritedEnv, RENNET_USER_DATA: userData },
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

    // The served browser UI (#381): the packaged daemon resolves its `dist/browser` sibling
    // (asar-unpacked) and serves the page at `/`. Prove the tab actually loads.
    const page = await fetch(`http://127.0.0.1:${claim.wsPort}/`);
    const pageBody = await page.text();
    if (page.status !== 200 || !pageBody.includes('<div id="root">')) {
      throw new Error(
        `Served browser UI missing at /: status ${page.status}\n${pageBody.slice(0, 200)}`,
      );
    }

    console.log(
      `Packaged app signature, fuse policy, update lifecycle, installed native payload (${nativePayload.nativeRoot}), launch, bundled-daemon health, and served browser UI smoke passed (daemon pid ${claim.pid}, port ${claim.wsPort}).`,
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

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  await smokePackagedApp(process.argv[2] ?? "");
}
