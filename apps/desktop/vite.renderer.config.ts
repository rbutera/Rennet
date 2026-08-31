import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: "./",
  root: resolve(here, "src/renderer"),
  plugins: [react(), tailwindcss()],
  build: {
    emptyOutDir: true,
    outDir: resolve(here, "dist/renderer"),
    // No prod sourcemap. The renderer map was 7 MB of the packaged app, shipped for
    // nobody: nothing reads it at runtime (no crash reporter, no source-map-support) and
    // dev debugging goes through the Vite dev server, which serves its own. Only
    // `dist/main/index.cjs.map` still ships — `scripts/smoke-packaged-app.mjs` reads its
    // `sourcesContent` to prove the packaged main bundle carries the code it claims.
    sourcemap: false,
    target: "chrome142",
  },
});
