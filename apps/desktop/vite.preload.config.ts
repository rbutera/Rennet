import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  build: {
    emptyOutDir: true,
    lib: {
      entry: resolve(here, "src/preload/index.ts"),
      formats: ["cjs"],
      fileName: () => "index.cjs",
    },
    outDir: resolve(here, "dist/preload"),
    rollupOptions: {
      external: ["electron", ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
    },
    // No prod sourcemap (perf audit §6, Wave 4 item 12): `dist/main/index.cjs.map` is the
    // ONE that stays, because `scripts/smoke-packaged-app.mjs` reads its `sourcesContent`
    // out of the asar. Nothing reads the preload's — no crash reporter, no
    // `source-map-support`, and dev debugging goes through the dev server — so it was 8 kB
    // of dead weight in every package, and the plan doc said it was already gone.
    target: "node24",
  },
});
