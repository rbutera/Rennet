import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stageT3Sidecar } from "./stage-t3-sidecar.mjs";

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
