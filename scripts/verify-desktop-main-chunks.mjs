#!/usr/bin/env node
// Post-build guard for the desktop main bundle.
//
// Two failure classes here only surface when a chunk is actually LOADED, and the
// model-free e2e cannot see them (it never fires a real model turn):
//   1. A split chunk emitted as `.js` loads as ESM under the package's
//      `"type": "module"` and crashes with "exports is not defined".
//   2. A bundler rewrite makes a chunk throw when required — e.g. the Claude Agent
//      SDK's `createRequire(import.meta.url)` becoming `createRequire(undefined)` in
//      CJS, which the app hits on the FIRST real review (`ERR_INVALID_ARG_VALUE`).
//
// So this requires every emitted split chunk in Node and asserts it loads. The entry
// `index.cjs` is excluded — it needs the electron runtime — and is covered instead by
// the launched-app e2e and the packaged-app smoke test.
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const dir = resolve(process.argv[2] ?? "apps/desktop/dist/main");
const require = createRequire(import.meta.url);
const entries = readdirSync(dir);

const strayEsmChunks = entries.filter((name) => name.endsWith(".js"));
if (strayEsmChunks.length > 0) {
  console.error(
    `FAIL: main chunks emitted as ESM .js (must be .cjs): ${strayEsmChunks.join(", ")}`,
  );
  process.exit(1);
}

const chunks = entries.filter((name) => name.endsWith(".cjs") && name !== "index.cjs");
let failed = 0;
for (const name of chunks) {
  try {
    require(join(dir, name));
    console.log(`OK ${name}`);
  } catch (error) {
    failed += 1;
    const code = error?.code ? `${error.code} ` : "";
    console.error(`FAIL ${name}: ${code}${String(error?.message).split("\n")[0]}`);
  }
}

if (failed > 0) {
  console.error(`${failed} main chunk(s) failed to load.`);
  process.exit(1);
}
console.log(`verified ${chunks.length} split main chunk(s) load`);
