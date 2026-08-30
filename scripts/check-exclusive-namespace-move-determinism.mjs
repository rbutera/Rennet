import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const buildScriptPath = join(workspaceRoot, "scripts", "build-exclusive-namespace-move.mjs");
const binaryName =
  process.platform === "win32" ? "rennet-exclusive-move.exe" : "rennet-exclusive-move";
const outputRoot = join(
  workspaceRoot,
  "packages",
  "adapters",
  "dist",
  "native",
  `${process.platform}-${process.arch}`,
);
const outputPaths = [join(outputRoot, binaryName), join(outputRoot, "rennet-rooted-landing.node")];

function runBuild(temporaryRoot) {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env };
    if (process.platform === "win32") {
      environment.TEMP = temporaryRoot;
      environment.TMP = temporaryRoot;
    } else {
      environment.TMPDIR = temporaryRoot;
    }

    const child = spawn(process.execPath, [buildScriptPath], {
      cwd: workspaceRoot,
      env: environment,
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
            ? `native build exited with code ${code}`
            : `native build terminated by ${signal}`,
        ),
      );
    });
  });
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

const proofRoot = await mkdtemp(join(tmpdir(), "rennet-exclusive-move-determinism-"));

try {
  const builds = new Map(outputPaths.map((outputPath) => [outputPath, []]));
  for (const name of ["first", "second"]) {
    const temporaryRoot = join(proofRoot, name);
    await mkdir(temporaryRoot, { recursive: true });
    await runBuild(temporaryRoot);
    for (const outputPath of outputPaths) {
      builds.get(outputPath).push(await readFile(outputPath));
    }
  }

  for (const [outputPath, artifacts] of builds) {
    const [first, second] = artifacts;
    if (first === undefined || second === undefined) {
      throw new Error(`native determinism proof did not produce two builds for ${outputPath}`);
    }
    const hashes = [sha256(first), sha256(second)];
    if (!first.equals(second)) {
      throw new Error(`${outputPath} differs across temporary roots: ${hashes[0]} != ${hashes[1]}`);
    }
    process.stdout.write(`${outputPath} is reproducible: ${hashes[0]}\n`);
  }
} finally {
  await rm(proofRoot, { force: true, recursive: true });
}
