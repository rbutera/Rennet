import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * @param {{
 *   sourceNativeRoot: string;
 *   bundleDirectory: string;
 *   platform: NodeJS.Platform;
 *   arch: string;
 * }} input
 */
export function stageNativeArtifacts(input) {
  const platformName = `${input.platform}-${input.arch}`;
  expectedArtifactNames(platformName);
  const rootEntries = readdirSync(input.sourceNativeRoot, { withFileTypes: true }).sort(
    (left, right) => left.name.localeCompare(right.name),
  );
  if (!rootEntries.some((entry) => entry.name === platformName && entry.isDirectory())) {
    throw new Error(
      `native platform directory is missing: ${join(input.sourceNativeRoot, platformName)}`,
    );
  }

  for (const rootEntry of rootEntries) {
    if (!rootEntry.isDirectory()) {
      throw new Error(`native artifact root entry ${rootEntry.name} must be a directory`);
    }
    const expectedNames = expectedArtifactNames(rootEntry.name);
    const platformDirectory = join(input.sourceNativeRoot, rootEntry.name);
    const artifactEntries = readdirSync(platformDirectory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    const actualNames = artifactEntries.map((entry) => entry.name);
    if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
      throw new Error(
        `native artifact directory ${rootEntry.name} must contain exactly ${expectedNames.join(
          ", ",
        )}; found ${actualNames.join(", ") || "nothing"}`,
      );
    }
    for (const artifactEntry of artifactEntries) {
      if (!artifactEntry.isFile()) {
        throw new Error(`${rootEntry.name}/${artifactEntry.name} must be a regular file`);
      }
    }
  }

  const destinationNativeRoot = join(input.bundleDirectory, "native");
  rmSync(destinationNativeRoot, { recursive: true, force: true });
  mkdirSync(input.bundleDirectory, { recursive: true });
  cpSync(input.sourceNativeRoot, destinationNativeRoot, { recursive: true });
}

function expectedArtifactNames(platformName) {
  const match = /^(darwin|linux|win32)-(arm64|x64)$/.exec(platformName);
  if (match === null) {
    throw new Error(`unsupported native artifact platform ${JSON.stringify(platformName)}`);
  }
  const moverName = match[1] === "win32" ? "rennet-exclusive-move.exe" : "rennet-exclusive-move";
  return [moverName, "rennet-rooted-landing.node"].sort();
}
