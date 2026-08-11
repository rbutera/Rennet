import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: { conditions: ["node", "import", "module", "default"] },
  build: {
    emptyOutDir: true,
    lib: {
      entry: resolve(here, "src/main/index.ts"),
      formats: ["cjs"],
      fileName: () => "index.cjs",
    },
    outDir: resolve(here, "dist/main"),
    rollupOptions: {
      external: ["electron", ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
      // The main is CJS, but `apps/desktop/package.json` is `"type": "module"`, so a
      // split chunk emitted with the default `.js` extension is loaded as ESM and
      // crashes with "exports is not defined". Force every shared/dynamic-import
      // chunk to `.cjs` so it is loaded as CommonJS, matching `index.cjs`.
      output: { chunkFileNames: "[name]-[hash].cjs" },
    },
    sourcemap: true,
    target: "node24",
  },
});
