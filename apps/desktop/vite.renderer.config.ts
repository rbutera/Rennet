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
    sourcemap: true,
    target: "chrome142",
  },
});
