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

// A harness platform binary must NEVER reach the packaged app. The Claude adapter depends
// on @anthropic-ai/claude-agent-sdk (a production dependency), whose per-platform package
// @anthropic-ai/claude-agent-sdk-<platform> carries a ~270 MB `claude` executable as its
// only real payload. Rennet spawns the user's OWN installed binary via
// pathToClaudeCodeExecutable, so a bundled copy is dead weight AND a bundled harness binary,
// which CLAUDE.md forbids. This pattern matches any file inside such a per-platform package
// directory; the main @anthropic-ai/claude-agent-sdk package (no trailing hyphen) is not
// matched here (its own vendored binaries are stripped by forge.config.cjs). It mirrors the
// packaging verification `find <out> -path '*claude-agent-sdk-*' -type f`.
export const harnessSdkPlatformArtifactPattern = /(?:^|\/)claude-agent-sdk-[^/]+\//;

async function collectMatchingFiles(root, pattern, relativePath, isRoot) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isRoot) {
      throw new Error(`packaged app directory ${root} is missing or unreadable`, { cause: error });
    }
    return [];
  }
  const matches = [];
  for (const entry of entries) {
    const childRelative = relativePath === "" ? entry.name : `${relativePath}/${entry.name}`;
    if (entry.isDirectory()) {
      // Skip symlinks (never descended: entry.isDirectory() is false for them), matching
      // `find <out> -type f`, which reports real files by their real path and cannot loop.
      matches.push(
        ...(await collectMatchingFiles(join(root, entry.name), pattern, childRelative, false)),
      );
    } else if (entry.isFile() && pattern.test(childRelative)) {
      matches.push(childRelative);
    }
  }
  return matches;
}

export async function findHarnessSdkPlatformArtifacts(packagedAppRoot) {
  const found = await collectMatchingFiles(
    packagedAppRoot,
    harnessSdkPlatformArtifactPattern,
    "",
    true,
  );
  return found.sort();
}

export async function assertNoHarnessSdkPlatformArtifacts(packagedAppRoot) {
  const offenders = await findHarnessSdkPlatformArtifacts(packagedAppRoot);
  if (offenders.length > 0) {
    throw new Error(
      `packaged app ships harness SDK platform artifacts that must be stripped at package time: ${offenders.join(", ")}`,
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
