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
const outputRoot = join(workspaceRoot, "packages", "adapters", "dist", "native");
const outputPath = join(outputRoot, `${process.platform}-${process.arch}`, binaryName);
const require = createRequire(import.meta.url);
const nodeGypPath = require.resolve("@electron/node-gyp/bin/node-gyp.js");
const scratchRoot = await mkdtemp(join(tmpdir(), "rennet-exclusive-move-"));

function runNodeGyp(cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [nodeGypPath, "rebuild", "--loglevel=error"], {
      cwd,
      // Electron's fork logs child options, including the environment, at verbose level.
      env: { ...process.env, NODE_GYP_NULL_LOGGER: "1" },
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
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
    ["binding.gyp", "exclusive-namespace-move.c"].map((filename) =>
      copyFile(join(nativeSourceRoot, filename), join(scratchRoot, filename)),
    ),
  );
  await runNodeGyp(scratchRoot);
  await rm(outputRoot, { force: true, recursive: true });
  await mkdir(dirname(outputPath), { recursive: true });
  await copyFile(join(scratchRoot, "build", "Release", basename(outputPath)), outputPath);
  if (process.platform !== "win32") await chmod(outputPath, 0o755);
} finally {
  await rm(scratchRoot, { force: true, recursive: true });
}
