import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stageT3Sidecar, stageWslSidecar } from "./stage-t3-sidecar.mjs";

test("Windows delivers the Linux chat runtime inside the WSL server directory", () => {
  const f = fixture();
  try {
    const linux = join(f.root, "linux-chat");
    const nativeDir = join(f.modules, "node-pty/build/Release");
    mkdirSync(nativeDir, { recursive: true });
    writeFileSync(join(nativeDir, "pty.node"), "linux-native-addon");
    stageT3Sidecar({
      vendorRoot: f.vendor,
      nodeModules: f.modules,
      destination: linux,
      platform: "linux",
      arch: "x64",
    });
    const serverDir = join(f.root, "server");
    stageWslSidecar({ source: linux, serverDir });
    const delivered = join(serverDir, "vendor/t3code");
    assert.ok(existsSync(join(delivered, "apps/server/dist/bin.mjs")));
    assert.ok(existsSync(join(delivered, "UPSTREAM.json")));
    assert.ok(existsSync(join(delivered, "apps/server/node_modules/node-pty/lib/index.js")));
    assert.equal(
      readFileSync(
        join(delivered, "apps/server/node_modules/node-pty/build/Release/pty.node"),
        "utf8",
      ),
      "linux-native-addon",
    );
    assert.ok(
      !existsSync(join(delivered, "apps/server/node_modules/node-pty/prebuilds/win32-x64")),
    );
    rmSync(join(linux, "apps/server/dist/bin.mjs"));
    assert.throws(() => stageWslSidecar({ source: linux, serverDir }), /Linux chat runtime/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rennet-stage-t3-"));
  const vendor = join(root, "vendor");
  mkdirSync(join(vendor, "apps/server/dist/chunks"), { recursive: true });
  writeFileSync(join(vendor, "apps/server/dist/bin.mjs"), "// bin");
  writeFileSync(join(vendor, "apps/server/dist/bin.mjs.map"), "{}");
  writeFileSync(join(vendor, "apps/server/dist/chunks/a.mjs"), "// a");
  writeFileSync(join(vendor, "UPSTREAM.json"), JSON.stringify({ commit: "abc" }));
  const modules = join(root, "node_modules");
  for (const dir of [
    "node-pty/prebuilds/darwin-arm64",
    "node-pty/prebuilds/win32-x64",
    "node-pty/lib",
    "@ff-labs/fff-node",
    "effect",
  ]) {
    mkdirSync(join(modules, dir), { recursive: true });
    writeFileSync(join(modules, dir, "index.js"), "");
  }
  return { root, vendor, modules, destination: join(root, "out") };
}

test("stages the bundle without maps, UPSTREAM.json beside it, and only the runtime externals", () => {
  const f = fixture();
  try {
    const result = stageT3Sidecar({
      vendorRoot: f.vendor,
      nodeModules: f.modules,
      destination: f.destination,
      platform: "darwin",
      arch: "arm64",
    });
    assert.equal(result.bundlePath, join(f.destination, "apps/server/dist/bin.mjs"));
    assert.ok(existsSync(result.bundlePath));
    assert.ok(existsSync(join(f.destination, "apps/server/dist/chunks/a.mjs")));
    assert.ok(!existsSync(join(f.destination, "apps/server/dist/bin.mjs.map")));
    // readUpstreamCommit walks ../../../UPSTREAM.json from the dist dir.
    assert.ok(existsSync(join(f.destination, "UPSTREAM.json")));
    assert.deepEqual(result.externals, ["@ff-labs/fff-node", "node-pty"]);
    const modules = join(f.destination, "apps/server/node_modules");
    assert.ok(existsSync(join(modules, "@ff-labs/fff-node/index.js")));
    assert.ok(existsSync(join(modules, "node-pty/lib/index.js")));
    assert.ok(existsSync(join(modules, "node-pty/prebuilds/darwin-arm64/index.js")));
    // Positive control for the prebuild filter: the other platform is gone.
    assert.ok(!existsSync(join(modules, "node-pty/prebuilds/win32-x64")));
    assert.ok(!existsSync(join(modules, "effect")));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("refuses to stage when the bundle is not built", () => {
  const f = fixture();
  try {
    rmSync(join(f.vendor, "apps/server/dist/bin.mjs"));
    assert.throws(
      () =>
        stageT3Sidecar({
          vendorRoot: f.vendor,
          nodeModules: f.modules,
          destination: f.destination,
        }),
      /not built/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// v0.6.4 shipped nothing: declaring `dependsOn` on the desktop build to pull in the T3
// server build REPLACED Nx's default `^build`, so the adapters native artifacts were never
// built on the release runner. The explicit list must keep `^build`.
test("the desktop build still depends on ^build beside the T3 server build", () => {
  const project = JSON.parse(
    readFileSync(new URL("../apps/desktop/project.json", import.meta.url), "utf8"),
  );
  const dependsOn = project.targets.build.dependsOn;
  assert.ok(
    dependsOn.includes("^build"),
    `desktop build dependsOn lost ^build: ${JSON.stringify(dependsOn)}`,
  );
  assert.ok(
    dependsOn.some((d) => typeof d === "object" && d.projects?.includes("t3code-server")),
    "desktop build must depend on t3code-server:build",
  );
});
