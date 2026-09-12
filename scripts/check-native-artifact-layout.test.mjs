import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createPackage } from "@electron/asar";
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

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("harness SDK platform artifact detection", () => {
  it("flags the per-platform package wherever it is nested (positive control)", async () => {
    const root = appRoot();
    // A clean bundle with the main SDK package present (its JS is fine to bundle) but no
    // per-platform package: nothing should be flagged.
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

    // Plant the exact shape the bead is about: the 270 MB darwin binary inside a staged
    // sidecar node_modules. The check must go red, naming the platform package.
    writeFileAt(
      root,
      "Rennet.app/Contents/Resources/t3code/apps/server/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude",
      "fake 270MB binary",
    );
    const offenders = await findHarnessSdkPlatformArtifacts(root);
    assert.ok(
      offenders.some((path) => path.endsWith("@anthropic-ai/claude-agent-sdk-darwin-arm64")),
      `expected an offender for the platform package, got ${JSON.stringify(offenders)}`,
    );
    await assert.rejects(
      assertNoHarnessSdkPlatformArtifacts(root),
      /harness SDK artifacts .*claude-agent-sdk-darwin-arm64/,
    );
  });

  it("flags the win32 claude.exe variant", async () => {
    const root = appRoot();
    writeFileAt(root, "node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe", "exe");
    await assert.rejects(assertNoHarnessSdkPlatformArtifacts(root), /claude-agent-sdk-win32-x64/);
  });

  it("flags the main package's vendored binary (forge strips it too)", async () => {
    const root = appRoot();
    writeFileAt(root, "node_modules/@anthropic-ai/claude-agent-sdk/vendor/claude", "vendored");
    await assert.rejects(
      assertNoHarnessSdkPlatformArtifacts(root),
      /@anthropic-ai\/claude-agent-sdk\/vendor/,
    );
  });

  it("flags a per-platform package inside an app.asar archive (route-independence)", async () => {
    const root = appRoot();
    const source = join(root, "asar-source");
    mkdirSync(join(source, "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64"), {
      recursive: true,
    });
    writeFileSync(
      join(source, "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude"),
      "binary",
    );
    const resources = join(root, "Rennet.app/Contents/Resources");
    mkdirSync(resources, { recursive: true });
    await createPackage(source, join(resources, "app.asar"));

    const offenders = await findHarnessSdkPlatformArtifacts(root);
    assert.ok(
      offenders.some(
        (path) => path.includes("app.asar > ") && path.includes("claude-agent-sdk-darwin-arm64"),
      ),
      `expected an app.asar offender, got ${JSON.stringify(offenders)}`,
    );
    await assert.rejects(assertNoHarnessSdkPlatformArtifacts(root), /app\.asar > /);
  });

  it("flags a symlinked binary and a symlinked package directory", async () => {
    const root = appRoot();
    // A symlinked `claude` under a real platform package directory (caught via the dir).
    const pkgDir = join(root, "a/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64");
    mkdirSync(pkgDir, { recursive: true });
    writeFileAt(root, "store/real-claude", "binary");
    symlinkSync(join(root, "store/real-claude"), join(pkgDir, "claude"));
    // A symlinked platform package directory (caught by name).
    mkdirSync(join(root, "b/node_modules/@anthropic-ai"), { recursive: true });
    mkdirSync(join(root, "store/real-pkg"), { recursive: true });
    symlinkSync(
      join(root, "store/real-pkg"),
      join(root, "b/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64"),
    );
    const offenders = await findHarnessSdkPlatformArtifacts(root);
    assert.ok(
      offenders.some((path) => path.endsWith("claude-agent-sdk-darwin-arm64")),
      "missed real dir",
    );
    assert.ok(
      offenders.some((path) => path.endsWith("claude-agent-sdk-linux-x64")),
      "missed symlinked dir",
    );
    await assert.rejects(assertNoHarnessSdkPlatformArtifacts(root));
  });

  it("does NOT flag the main claude-agent-sdk package JS (negative control)", async () => {
    const root = appRoot();
    // The main package has no trailing hyphen; its bundled JS legitimately appears and must
    // not trip the platform-package pattern.
    writeFileAt(root, "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs", "js");
    writeFileAt(root, "node_modules/@anthropic-ai/claude-agent-sdk/cli.js", "js");
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

  it("throws (never green) when the packaged app root is missing", async () => {
    await assert.rejects(
      assertNoHarnessSdkPlatformArtifacts(join(tmpdir(), "rennet-does-not-exist-xyz")),
      /packaged app directory .* is unreadable/,
    );
  });

  it("throws (never green) when a nested directory is unreadable", { skip: isRoot }, async () => {
    const root = appRoot();
    const locked = join(root, "Rennet.app/Contents/Resources/locked");
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, "placeholder"), "x");
    chmodSync(locked, 0);
    try {
      await assert.rejects(
        assertNoHarnessSdkPlatformArtifacts(root),
        /packaged directory .* is unreadable/,
      );
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});
