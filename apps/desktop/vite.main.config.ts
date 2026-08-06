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
    },
    sourcemap: true,
    target: "node24",
  },
});
