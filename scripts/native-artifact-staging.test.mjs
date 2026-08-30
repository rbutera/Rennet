import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { stageNativeArtifacts } from "./native-artifact-staging.mjs";

const roots = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rennet-native-staging-"));
  roots.push(root);
  return {
    sourceNativeRoot: join(root, "adapter-native"),
    bundleDirectory: join(root, "server-bundle"),
  };
}

function putArtifacts(sourceNativeRoot, platform, arch) {
  const platformDirectory = join(sourceNativeRoot, `${platform}-${arch}`);
  mkdirSync(platformDirectory, { recursive: true });
  writeFileSync(join(platformDirectory, "rennet-rooted-landing.node"), `${platform} addon`);
  writeFileSync(
    join(
      platformDirectory,
      platform === "win32" ? "rennet-exclusive-move.exe" : "rennet-exclusive-move",
    ),
    `${platform} mover`,
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("native server-bundle artifact staging", () => {
  it("mirrors every complete platform into exact bundle paths", () => {
    const { sourceNativeRoot, bundleDirectory } = fixture();
    putArtifacts(sourceNativeRoot, "darwin", "arm64");
    putArtifacts(sourceNativeRoot, "win32", "x64");
    const staleDirectory = join(bundleDirectory, "native/linux-x64");
    mkdirSync(staleDirectory, { recursive: true });
    writeFileSync(join(staleDirectory, "stale-artifact"), "stale");

    stageNativeArtifacts({
      sourceNativeRoot,
      bundleDirectory,
      platform: "darwin",
      arch: "arm64",
    });

    for (const path of [
      join(bundleDirectory, "native/darwin-arm64/rennet-rooted-landing.node"),
      join(bundleDirectory, "native/darwin-arm64/rennet-exclusive-move"),
      join(bundleDirectory, "native/win32-x64/rennet-rooted-landing.node"),
      join(bundleDirectory, "native/win32-x64/rennet-exclusive-move.exe"),
    ]) {
      assert.equal(existsSync(path), true, `missing staged artifact ${path}`);
    }
    assert.equal(existsSync(staleDirectory), false, "stale platform survived mirror staging");
  });

  it("refuses an incomplete sibling platform before replacing the bundle", () => {
    const { sourceNativeRoot, bundleDirectory } = fixture();
    putArtifacts(sourceNativeRoot, "win32", "x64");
    const linuxDirectory = join(sourceNativeRoot, "linux-x64");
    mkdirSync(linuxDirectory, { recursive: true });
    writeFileSync(join(linuxDirectory, "rennet-rooted-landing.node"), "addon only");
    const existingBundleArtifact = join(bundleDirectory, "native/win32-x64/existing");
    mkdirSync(join(bundleDirectory, "native/win32-x64"), { recursive: true });
    writeFileSync(existingBundleArtifact, "keep on failed validation");

    assert.throws(
      () =>
        stageNativeArtifacts({
          sourceNativeRoot,
          bundleDirectory,
          platform: "win32",
          arch: "x64",
        }),
      /linux-x64.*rennet-exclusive-move/s,
    );
    assert.equal(existsSync(existingBundleArtifact), true);
  });

  for (const invalidSource of [
    {
      name: "an unexpected artifact",
      mutate(sourceNativeRoot) {
        writeFileSync(join(sourceNativeRoot, "darwin-arm64/unexpected"), "extra");
      },
      expected: /must contain exactly/,
    },
    {
      name: "a non-regular artifact",
      mutate(sourceNativeRoot) {
        const addonPath = join(sourceNativeRoot, "darwin-arm64/rennet-rooted-landing.node");
        rmSync(addonPath);
        mkdirSync(addonPath);
      },
      expected: /must be a regular file/,
    },
    {
      name: "an unsupported platform directory",
      mutate(sourceNativeRoot) {
        putArtifacts(sourceNativeRoot, "freebsd", "x64");
      },
      expected: /unsupported native artifact platform "freebsd-x64"/,
    },
    {
      name: "a root file",
      mutate(sourceNativeRoot) {
        writeFileSync(join(sourceNativeRoot, "payload.txt"), "not a platform directory");
      },
      expected: /native artifact root entry payload\.txt must be a directory/,
    },
  ]) {
    it(`rejects ${invalidSource.name} before replacing the bundle`, () => {
      const { sourceNativeRoot, bundleDirectory } = fixture();
      putArtifacts(sourceNativeRoot, "darwin", "arm64");
      invalidSource.mutate(sourceNativeRoot);
      const existingBundleArtifact = join(bundleDirectory, "native/darwin-arm64/existing");
      mkdirSync(join(bundleDirectory, "native/darwin-arm64"), { recursive: true });
      writeFileSync(existingBundleArtifact, "keep on failed validation");

      assert.throws(
        () =>
          stageNativeArtifacts({
            sourceNativeRoot,
            bundleDirectory,
            platform: "darwin",
            arch: "arm64",
          }),
        invalidSource.expected,
      );
      assert.equal(existsSync(existingBundleArtifact), true);
    });
  }
});
