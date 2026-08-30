import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const nativeSourceRoot = join(workspaceRoot, "packages", "adapters", "native");
const binaryName =
  process.platform === "win32" ? "rennet-exclusive-move.exe" : "rennet-exclusive-move";
const addonName = "rennet-rooted-landing.node";
const outputRoot = join(workspaceRoot, "packages", "adapters", "dist", "native");
const platformOutputRoot = join(outputRoot, `${process.platform}-${process.arch}`);
const outputPath = join(platformOutputRoot, binaryName);
const addonOutputPath = join(platformOutputRoot, addonName);
const require = createRequire(import.meta.url);
const nodeGypPath = require.resolve("@electron/node-gyp/bin/node-gyp.js");
const scratchRoot = await mkdtemp(join(tmpdir(), "rennet-exclusive-move-"));

// The pinned fork treats hidden logger levels as visible; its silly records
// include child options and the environment.
function forwardSafeNodeGypStderr(stream) {
  let pending = "";
  const forward = (line) => {
    if (!/^gyp (?:sill|verb|info|http|notice|WARN)\b/.test(line)) {
      process.stderr.write(`${line}\n`);
    }
  };
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    const lines = `${pending}${chunk}`.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) forward(line);
  });
  stream.on("end", () => {
    if (pending !== "") forward(pending);
  });
}

function runNodeGyp(cwd) {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env, npm_config_loglevel: "error" };
    delete environment.NODE_GYP_NULL_LOGGER;
    const child = spawn(process.execPath, [nodeGypPath, "--loglevel=error", "rebuild"], {
      cwd,
      // Error-level output preserves actionable toolchain failures without the
      // verbose child options that include the environment.
      env: environment,
      shell: false,
      stdio: ["ignore", "inherit", "pipe"],
      windowsHide: true,
    });
    forwardSafeNodeGypStderr(child.stderr);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal === null
            ? `@electron/node-gyp exited with code ${code}`
            : `@electron/node-gyp terminated by ${signal}`,
        ),
      );
    });
  });
}

try {
  await Promise.all(
    ["binding.gyp", "exclusive-namespace-move.c", "rooted-landing-host.c"].map((filename) =>
      copyFile(join(nativeSourceRoot, filename), join(scratchRoot, filename)),
    ),
  );
  await runNodeGyp(scratchRoot);
  await rm(outputRoot, { force: true, recursive: true });
  await mkdir(platformOutputRoot, { recursive: true });
  await copyFile(join(scratchRoot, "build", "Release", basename(outputPath)), outputPath);
  await copyFile(join(scratchRoot, "build", "Release", basename(addonOutputPath)), addonOutputPath);
  if (process.platform !== "win32") await chmod(outputPath, 0o755);
} finally {
  await rm(scratchRoot, { force: true, recursive: true });
}
