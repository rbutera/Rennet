import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

// The browser shell (issue #381, design D1): the SAME app in a second shell. Built like
// the renderer (base "./", react plugin) but from `src/browser` to `dist/browser`, which
// the daemon serves over its HTTP port. No preload — the browser tab reaches the daemon
// purely over WebSocket at the serving origin (or a saved remote), and its own CSP meta
// widens connect-src to `ws: wss:` so it can attach to a remote daemon by host.
export default defineConfig({
  base: "./",
  root: resolve(here, "src/browser"),
  plugins: [react()],
  build: {
    emptyOutDir: true,
    outDir: resolve(here, "dist/browser"),
    sourcemap: true,
    target: "chrome142",
  },
});
