import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const nativeArtifactRoot = join(workspaceRoot, "packages", "adapters", "dist", "native");

export function nativeArtifactNames(platformArchitecture) {
  const match = /^(darwin|linux|win32)-(arm64|x64)$/.exec(platformArchitecture);
  if (match === null) {
    throw new Error(`unsupported native artifact platform ${JSON.stringify(platformArchitecture)}`);
  }
  const binaryName = match[1] === "win32" ? "rennet-exclusive-move.exe" : "rennet-exclusive-move";
  return [binaryName, "rennet-rooted-landing.node"].sort();
}

async function entriesAt(path, label) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    throw new Error(`${label} is missing or unreadable`, { cause: error });
  }
}

function namesOf(entries) {
  return entries.map((entry) => entry.name).sort();
}

function assertSameNames(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label} must contain exactly ${expected.join(", ")}; found ${actual.join(", ") || "nothing"}`,
    );
  }
}

export async function assertNativePlatformArtifacts(root, platformArchitecture) {
  const expectedNames = nativeArtifactNames(platformArchitecture);
  const platformRoot = join(root, platformArchitecture);
  const entries = await entriesAt(
    platformRoot,
    `native artifact directory ${platformArchitecture}`,
  );
  assertSameNames(
    namesOf(entries),
    expectedNames,
    `native artifact directory ${platformArchitecture}`,
  );
  for (const entry of entries) {
    if (!entry.isFile()) {
      throw new Error(`${platformArchitecture}/${entry.name} must be a regular file`);
    }
  }
}

export async function assertNativeArtifactLayout(root, platformArchitectures) {
  if (platformArchitectures.length === 0) {
    throw new Error("at least one native artifact platform is required");
  }
  const expectedPlatforms = [...new Set(platformArchitectures)].sort();
  if (expectedPlatforms.length !== platformArchitectures.length) {
    throw new Error("native artifact platforms must be unique");
  }
  for (const platformArchitecture of expectedPlatforms) {
    nativeArtifactNames(platformArchitecture);
  }

  const rootEntries = await entriesAt(root, "native artifact root");
  assertSameNames(namesOf(rootEntries), expectedPlatforms, "native artifact root");
  for (const entry of rootEntries) {
    if (!entry.isDirectory()) {
      throw new Error(`native artifact root entry ${entry.name} must be a directory`);
    }
  }
  for (const platformArchitecture of expectedPlatforms) {
    await assertNativePlatformArtifacts(root, platformArchitecture);
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    const platformArchitectures = process.argv.slice(2);
    await assertNativeArtifactLayout(nativeArtifactRoot, platformArchitectures);
    process.stdout.write(
      `native artifacts have the exact ${platformArchitectures.sort().join(" + ")} layout\n`,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`native-artifact-layout: ${detail}\n`);
    process.exitCode = 1;
  }
}
