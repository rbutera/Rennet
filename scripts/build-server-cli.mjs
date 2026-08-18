#!/usr/bin/env node
import { chmodSync } from "node:fs";
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
  // Two adapters call `new URL("./x.json", import.meta.url)` in LAZY calibration-tooling
  // functions (never on the daemon's serve/status/stop path). Under CJS esbuild leaves
  // import.meta.url empty and warns; that's harmless here because the daemon never calls
  // those functions. The committed calibration tables are static `import`s and inline
  // regardless. logLevel keeps the warning visible without failing the build.
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "warning",
});

chmodSync(outfile, 0o755);
console.log(`built ${outfile}`);
