// Stage the vendored T3 Code server bundle for the packaged desktop app.
//
// The daemon spawns the sidecar from `vendor/t3code/apps/server/dist/bin.mjs` in a
// checkout; a packaged app has no checkout, so the desktop build copies that bundle (maps
// dropped) plus `UPSTREAM.json` and the runtime-external native packages the bundle
// leaves un-inlined (node-pty, ffi-rs, fff-node and friends: see
// vendor/t3code/scripts/lib/cli-external-packages.ts) into `apps/desktop/dist/t3code/`,
// mirroring the vendored layout so `readUpstreamCommit`'s relative walk still lands.
// Forge ships that directory as an extra resource; the main process points the daemon at
// `<resourcesPath>/t3code/apps/server/dist/bin.mjs` through RENNET_T3_BUNDLE.
//
// Only the running platform's prebuilds are kept for packages that carry several
// (node-pty ships 58 MB of prebuilds for four platforms; one is 15 MB).

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Runtime externals, as upstream declares them (prefixes). */
export const RUNTIME_EXTERNAL_PREFIXES = [
  "node-pty",
  "ffi-rs",
  "@yuuang/",
  "@ff-labs/",
  "@clerk/electron-passkeys",
  "@msgpackr-extract/",
  "msgpackr-extract",
  "node-gyp-build",
  "node-addon-api",
  "detect-libc",
  "bufferutil",
  "utf-8-validate",
];

function listPackages(nodeModules) {
  if (!existsSync(nodeModules)) return [];
  const names = [];
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith("@")) {
      for (const scoped of readdirSync(join(nodeModules, entry.name), { withFileTypes: true })) {
        if (scoped.isDirectory() || scoped.isSymbolicLink())
          names.push(`${entry.name}/${scoped.name}`);
      }
    } else {
      names.push(entry.name);
    }
  }
  return names.sort();
}

/**
 * @param {{
 *   vendorRoot: string;      // vendor/t3code
 *   nodeModules: string;     // the hoisted node_modules to take externals from
 *   destination: string;     // apps/desktop/dist/t3code
 *   platform?: NodeJS.Platform;
 *   arch?: string;
 * }} input
 * @returns {{ bundlePath: string; externals: string[] }}
 */
export function stageT3Sidecar(input) {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const sourceDist = join(input.vendorRoot, "apps/server/dist");
  const bin = join(sourceDist, "bin.mjs");
  if (!existsSync(bin)) {
    throw new Error(`T3 server bundle is not built: ${bin} (run nx run t3code-server:build)`);
  }
  rmSync(input.destination, { recursive: true, force: true });
  const destDist = join(input.destination, "apps/server/dist");
  mkdirSync(destDist, { recursive: true });
  cpSync(sourceDist, destDist, {
    recursive: true,
    filter: (source) => !source.endsWith(".map"),
  });
  cpSync(join(input.vendorRoot, "UPSTREAM.json"), join(input.destination, "UPSTREAM.json"));

  const platformTag = `${platform}-${arch}`;
  const externals = listPackages(input.nodeModules).filter((name) =>
    RUNTIME_EXTERNAL_PREFIXES.some((prefix) => name.startsWith(prefix)),
  );
  const destModules = join(input.destination, "apps/server/node_modules");
  for (const name of externals) {
    const from = join(input.nodeModules, name);
    const to = join(destModules, name);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, {
      recursive: true,
      dereference: true,
      filter: (source) => {
        // Keep one platform's prebuilds (node-pty's `prebuilds/<platform-arch>/`).
        const rel = source.slice(from.length + 1);
        const [head, sub] = rel.split(/[\\/]/);
        if (head === "prebuilds" && sub !== undefined && sub !== "" && sub !== platformTag) {
          return false;
        }
        return !rel.endsWith(".map");
      },
    });
  }
  return { bundlePath: join(destDist, "bin.mjs"), externals };
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = stageT3Sidecar({
    vendorRoot: join(workspaceRoot, "vendor/t3code"),
    nodeModules: join(workspaceRoot, "node_modules"),
    destination: join(workspaceRoot, "apps/desktop/dist/t3code"),
  });
  console.log(
    `staged T3 sidecar bundle at ${result.bundlePath} with ${result.externals.length} external packages`,
  );
}
