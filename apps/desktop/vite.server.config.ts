import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

// The detached daemon bundle (#379, design D5): the 4th desktop lib build. The packaged
// app spawns this with `ELECTRON_RUN_AS_NODE=1` (plain Node, no window), so it is bundled
// exactly like the main process — CJS, electron + node builtins external, everything else
// inlined — and verified the same way (verify-desktop-main-chunks over dist/server). Its
// entry is the server package's daemon entry, which serves on load.
export default defineConfig({
  resolve: { conditions: ["node", "import", "module", "default"] },
  define: {
    "import.meta.url": 'require("node:url").pathToFileURL(__filename).href',
  },
  build: {
    emptyOutDir: true,
    lib: {
      entry: resolve(here, "../../packages/server/src/daemon-main.ts"),
      formats: ["cjs"],
      fileName: () => "index.cjs",
    },
    outDir: resolve(here, "dist/server"),
    rollupOptions: {
      external: ["electron", ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
      output: { chunkFileNames: "[name]-[hash].cjs" },
    },
    sourcemap: true,
    target: "node24",
  },
});
