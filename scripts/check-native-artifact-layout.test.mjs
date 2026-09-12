import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  assertNoHarnessSdkPlatformArtifacts,
  findHarnessSdkPlatformArtifacts,
  harnessSdkPlatformArtifactPattern,
} from "./check-native-artifact-layout.mjs";

const roots = [];

function appRoot() {
  const root = mkdtempSync(join(tmpdir(), "rennet-harness-sdk-"));
  roots.push(root);
  return root;
}

function writeFileAt(root, relativePath, contents) {
  const full = join(root, relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("harness SDK platform artifact detection", () => {
  it("flags the per-platform claude binary wherever it is nested (positive control)", async () => {
    const root = appRoot();
    // A clean bundle with the main SDK package present (its JS is fine to bundle) but no
    // per-platform binary: nothing should be flagged.
    writeFileAt(
      root,
      "Rennet.app/Contents/Resources/app.asar.unpacked/dist/server/index.cjs",
      "ok",
    );
    writeFileAt(
      root,
      "Rennet.app/Contents/Resources/t3code/apps/server/node_modules/@anthropic-ai/claude-agent-sdk/cli.js",
      "sdk js",
    );
    assert.deepEqual(await findHarnessSdkPlatformArtifacts(root), []);
    await assertNoHarnessSdkPlatformArtifacts(root);

    // Now plant the exact shape the bead is about: the 270 MB darwin binary inside a staged
    // sidecar node_modules. The check must go red.
    writeFileAt(
      root,
      "Rennet.app/Contents/Resources/t3code/apps/server/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude",
      "fake 270MB binary",
    );
    const offenders = await findHarnessSdkPlatformArtifacts(root);
    assert.deepEqual(offenders, [
      "Rennet.app/Contents/Resources/t3code/apps/server/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude",
    ]);
    await assert.rejects(
      assertNoHarnessSdkPlatformArtifacts(root),
      /harness SDK platform artifacts .*claude-agent-sdk-darwin-arm64\/claude/,
    );
  });

  it("flags the win32 claude.exe variant", async () => {
    const root = appRoot();
    writeFileAt(root, "node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe", "exe");
    await assert.rejects(assertNoHarnessSdkPlatformArtifacts(root), /claude-agent-sdk-win32-x64/);
  });

  it("does NOT flag the main claude-agent-sdk package (negative control)", async () => {
    const root = appRoot();
    // The main package has no trailing hyphen; its bundled JS legitimately appears in the
    // build and must not trip the platform-package pattern.
    writeFileAt(root, "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs", "js");
    writeFileAt(root, "node_modules/@anthropic-ai/claude-agent-sdk/README.md", "readme");
    assert.equal(
      harnessSdkPlatformArtifactPattern.test("node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"),
      false,
    );
    assert.deepEqual(await findHarnessSdkPlatformArtifacts(root), []);
    await assertNoHarnessSdkPlatformArtifacts(root);
  });

  it("does NOT flag an unrelated file merely named claude", async () => {
    const root = appRoot();
    writeFileAt(root, "Rennet.app/Contents/Resources/bin/claude", "unrelated launcher");
    assert.deepEqual(await findHarnessSdkPlatformArtifacts(root), []);
    await assertNoHarnessSdkPlatformArtifacts(root);
  });

  it("throws a clear error when the packaged app root is missing", async () => {
    await assert.rejects(
      assertNoHarnessSdkPlatformArtifacts(join(tmpdir(), "rennet-does-not-exist-xyz")),
      /missing or unreadable/,
    );
  });
});
