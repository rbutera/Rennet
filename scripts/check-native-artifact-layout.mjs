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

// Harness SDK artifacts that must NEVER reach the packaged app. The Claude adapter depends
// on @anthropic-ai/claude-agent-sdk (a production dependency); its per-platform package
// @anthropic-ai/claude-agent-sdk-<platform> carries a ~270 MB `claude` executable as its
// only real payload, and the main package can vendor its own CLI binary too. Rennet spawns
// the user's OWN installed binary via pathToClaudeCodeExecutable, so a bundled copy is dead
// weight AND a bundled harness binary, which CLAUDE.md forbids. These mirror the
// HARNESS_SDK_FILE_EXCLUSIONS in forge.config.cjs, expressed as an assertion at the packaged
// output so the guard holds by ANY route the exclusions might miss (a staged sidecar
// node_modules, a copied asset, a future change to the packager ignore list). The main
// package's own JS bundle (e.g. sdk.mjs, cli.js) is intentionally NOT matched.
export const forbiddenHarnessSdkPatterns = [
  // a per-platform package directory and everything inside it (trailing hyphen keeps this
  // from matching the main claude-agent-sdk package)
  /(?:^|\/)claude-agent-sdk-[^/]+(?:\/|$)/,
  // the main package's vendored payload directory
  /(?:^|\/)@anthropic-ai\/claude-agent-sdk\/vendor(?:\/|$)/,
  // a `cli`/`claude` executable vendored anywhere inside the main package
  /(?:^|\/)@anthropic-ai\/claude-agent-sdk\/.*\/(?:cli|claude)(?:\.exe)?$/,
];

// Kept as a named export for direct reference (the per-platform binary shape).
export const harnessSdkPlatformArtifactPattern = forbiddenHarnessSdkPatterns[0];

function matchesForbiddenHarnessSdk(relativePath) {
  return forbiddenHarnessSdkPatterns.some((pattern) => pattern.test(relativePath));
}

async function collectFilesystemMatches(root, relativePath, isRoot, asarRelativePaths) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    // A traversal failure must NEVER read as "clean": that fails toward shipping the binary.
    // Surface it so the packaging verify goes could-not-check rather than silently green.
    const label = isRoot ? "packaged app directory" : "packaged directory";
    throw new Error(`${label} ${root} is unreadable`, { cause: error });
  }
  const matches = [];
  for (const entry of entries) {
    const childRelative = relativePath === "" ? entry.name : `${relativePath}/${entry.name}`;
    if (matchesForbiddenHarnessSdk(childRelative)) {
      // Report by path and do not descend: this catches a matching file, a symlinked binary,
      // and a symlinked or real package directory alike, and the whole subtree is forbidden.
      matches.push(childRelative);
      continue;
    }
    // Never follow symlinks (avoids loops); a matching symlink is already caught above.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      matches.push(
        ...(await collectFilesystemMatches(
          join(root, entry.name),
          childRelative,
          false,
          asarRelativePaths,
        )),
      );
    } else if (entry.isFile() && entry.name.endsWith(".asar")) {
      // An asar is an archive, so a forbidden path can hide inside it; enumerate it below.
      asarRelativePaths.push(childRelative);
    }
  }
  return matches;
}

async function collectAsarMatches(packagedAppRoot, asarRelativePath) {
  let asar;
  try {
    asar = await import("@electron/asar");
  } catch (error) {
    // An asar exists but we cannot read it: could-not-check, never green.
    throw new Error(`cannot verify ${asarRelativePath}: @electron/asar is not resolvable`, {
      cause: error,
    });
  }
  const listPackage = asar.listPackage ?? asar.default?.listPackage;
  if (typeof listPackage !== "function") {
    throw new Error(`cannot verify ${asarRelativePath}: @electron/asar has no listPackage`);
  }
  return listPackage(join(packagedAppRoot, asarRelativePath))
    .map((internalPath) => internalPath.replace(/^\/+/, ""))
    .filter((internalPath) => matchesForbiddenHarnessSdk(internalPath))
    .map((internalPath) => `${asarRelativePath} > ${internalPath}`);
}

export async function findHarnessSdkPlatformArtifacts(packagedAppRoot) {
  const asarRelativePaths = [];
  const matches = await collectFilesystemMatches(packagedAppRoot, "", true, asarRelativePaths);
  for (const asarRelativePath of asarRelativePaths) {
    matches.push(...(await collectAsarMatches(packagedAppRoot, asarRelativePath)));
  }
  return matches.sort();
}

export async function assertNoHarnessSdkPlatformArtifacts(packagedAppRoot) {
  const offenders = await findHarnessSdkPlatformArtifacts(packagedAppRoot);
  if (offenders.length > 0) {
    throw new Error(
      `packaged app ships harness SDK artifacts that must be stripped at package time: ${offenders.join(", ")}`,
    );
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    const arguments_ = process.argv.slice(2);
    if (arguments_[0] === "--assert-no-harness-sdk") {
      const appRoot = arguments_[1];
      if (appRoot === undefined)
        throw new Error("--assert-no-harness-sdk requires a packaged app path");
      const resolvedAppRoot = resolve(appRoot);
      await assertNoHarnessSdkPlatformArtifacts(resolvedAppRoot);
      process.stdout.write(`no harness SDK platform artifacts under ${resolvedAppRoot}\n`);
    } else {
      let root = nativeArtifactRoot;
      if (arguments_[0] === "--root") {
        const explicitRoot = arguments_[1];
        if (explicitRoot === undefined) throw new Error("--root requires a path");
        root = resolve(explicitRoot);
        arguments_.splice(0, 2);
      }
      const platformArchitectures = arguments_;
      await assertNativeArtifactLayout(root, platformArchitectures);
      process.stdout.write(
        `native artifacts at ${root} have the exact ${platformArchitectures.sort().join(" + ")} layout\n`,
      );
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`native-artifact-layout: ${detail}\n`);
    process.exitCode = 1;
  }
}
