#!/usr/bin/env node
import { chmodSync, cpSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Bundle the `rennet` CLI to a single runnable CJS file (#379). The workspace is
// source-only (`noEmit`, Bundler resolution with extensionless imports), so nothing runs
// the server's TS directly under Node — a bundle is the runnable form. esbuild follows the
// same extensionless/Bundler resolution the type-checker does, so `dist/rennet.cjs` carries
// the CLI plus every @rennet/* module it reaches. electron and the Claude SDK stay external:
// electron is never used on the server path, and the SDK is loaded lazily from node_modules
// only when a real review turn fires.
import { build } from "esbuild";
import { stageNativeArtifacts } from "./native-artifact-staging.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, "../packages/server");
const outfile = resolve(serverRoot, "dist/rennet.cjs");

await build({
  entryPoints: [resolve(serverRoot, "src/cli-main.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron", "@anthropic-ai/claude-agent-sdk"],
  define: {
    "import.meta.url": "__rennetBundledImportMetaUrl",
  },
  banner: {
    js: `#!/usr/bin/env node
const __rennetBundledImportMetaUrl = require("node:url").pathToFileURL(__filename).href;`,
  },
  logLevel: "warning",
});

chmodSync(outfile, 0o755);

// `@rennet/prompts` is INLINED into the bundle, so its prompt `.md` files cannot be
// require.resolve'd at runtime; `create-server.ts` reads them from `<bundle-dir>/prompts/`.
// Copy them next to `rennet.cjs` so the detached CLI daemon (#379) can draft boards — without
// this, every lens drafter hits ENOENT and a captured review never gets a board.
cpSync(resolve(here, "../packages/prompts/src/prompts"), resolve(serverRoot, "dist/prompts"), {
  recursive: true,
});
stageNativeArtifacts({
  sourceNativeRoot: resolve(here, "../packages/adapters/dist/native"),
  bundleDirectory: dirname(outfile),
  platform: process.platform,
  arch: process.arch,
});

console.log(`built ${outfile}`);
