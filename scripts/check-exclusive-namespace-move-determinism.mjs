import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNativeArtifactLayout,
  assertNativePlatformArtifacts,
  nativeArtifactNames,
} from "./check-native-artifact-layout.mjs";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const buildScriptPath = join(workspaceRoot, "scripts", "build-exclusive-namespace-move.mjs");
const nativeOutputRoot = join(workspaceRoot, "packages", "adapters", "dist", "native");
const platformArchitecture = `${process.platform}-${process.arch}`;
const platformOutputRoot = join(nativeOutputRoot, platformArchitecture);
const outputPaths = nativeArtifactNames(platformArchitecture).map((name) =>
  join(platformOutputRoot, name),
);

async function proveExactLayoutCheck(proofRoot) {
  const controlRoot = join(proofRoot, "layout-control");
  const controlPlatformRoot = join(controlRoot, platformArchitecture);
  await mkdir(controlPlatformRoot, { recursive: true });
  for (const artifactName of nativeArtifactNames(platformArchitecture)) {
    await writeFile(join(controlPlatformRoot, artifactName), artifactName);
  }
  const unexpectedName = "unexpected-native-artifact";
  const unexpectedPath = join(controlPlatformRoot, unexpectedName);
  await writeFile(unexpectedPath, "positive control");

  let rejected = false;
  try {
    await assertNativeArtifactLayout(controlRoot, [platformArchitecture]);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes(unexpectedName)) throw error;
    rejected = true;
  }
  if (!rejected) throw new Error("native artifact layout positive control did not fail");

  await rm(unexpectedPath);
  await assertNativeArtifactLayout(controlRoot, [platformArchitecture]);
  process.stdout.write("native artifact layout positive control rejected an extra artifact\n");
}

async function assertSiblingPreserved(sentinelPath, expectedContents) {
  let actualContents;
  try {
    actualContents = await readFile(sentinelPath);
  } catch (error) {
    throw new Error("native build removed a sibling platform output", { cause: error });
  }
  if (!actualContents.equals(expectedContents)) {
    throw new Error("native build changed a sibling platform output");
  }
}

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
let siblingControlRoot;

try {
  await proveExactLayoutCheck(proofRoot);
  await mkdir(nativeOutputRoot, { recursive: true });
  siblingControlRoot = await mkdtemp(join(nativeOutputRoot, "sibling-preservation-control-"));
  const sentinelPath = join(siblingControlRoot, "sentinel");
  const sentinelContents = Buffer.from("preserve sibling platform output\n");
  await writeFile(sentinelPath, sentinelContents);

  const builds = new Map(outputPaths.map((outputPath) => [outputPath, []]));
  for (const name of ["first", "second"]) {
    const temporaryRoot = join(proofRoot, name);
    await mkdir(temporaryRoot, { recursive: true });
    await runBuild(temporaryRoot);
    await assertSiblingPreserved(sentinelPath, sentinelContents);
    await assertNativePlatformArtifacts(nativeOutputRoot, platformArchitecture);
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
  if (siblingControlRoot !== undefined) {
    await rm(siblingControlRoot, { force: true, recursive: true });
  }
  await rm(proofRoot, { force: true, recursive: true });
}
