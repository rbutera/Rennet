import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const t3Web = resolve(here, "../../vendor/t3code/apps/web");
const t3WebVersion = (
  JSON.parse(readFileSync(resolve(t3Web, "package.json"), "utf8")) as {
    version: string;
  }
).version;

// The browser shell (issue #381, design D1): the SAME app in a second shell. Built like
// the renderer (base "./", react plugin) but from `src/browser` to `dist/browser`, which
// the daemon serves over its HTTP port. No preload — the browser tab reaches the daemon
// purely over WebSocket at the serving origin (or a saved remote), and its own CSP meta
// widens connect-src to `ws: wss:` so it can attach to a remote daemon by host.
//
// The two bundles LOOK like duplicates (both ~1.86 MB, because `@rennet/app-ui` is almost
// all of both) but they are NOT one build copied twice, so `dist/browser` cannot be dropped
// for a `cpSync` of `dist/renderer` (perf audit 2026-08-31, §6 M3 — investigated, declined).
// The entries differ: `src/browser/entry.tsx` builds its bridge from `location`, routes on
// `browserHistory`, and composes the `repository.choose` interception from
// `shell-intercepts.ts`; `src/renderer/index.tsx` reads `window.rennet` (the preload), routes
// on `hashHistory`, and resolves a WSL daemon target through `wsl-connect.ts`. Neither entry
// is reachable from the other's shell, so a shared build would ship both — and the browser
// tab would then carry preload-shaped code that has no preload behind it.
export default defineConfig({
  base: "./",
  root: resolve(here, "src/browser"),
  plugins: [react(), tailwindcss()],
  // The same four pieces `vite.renderer.config.ts` carries, for the same reason: with the
  // rung-one <webview> gone (t3-lens-threads 4.4) the browser tab mounts the SAME native
  // `@rennet/t3-chat` view the desktop does, and that mount imports the vendored T3 Code
  // web app by module.
  resolve: {
    alias: { "~": resolve(t3Web, "src") },
    dedupe: ["react", "react-dom"],
  },
  define: {
    "import.meta.env.APP_VERSION": JSON.stringify(t3WebVersion),
    "import.meta.env.VITE_HOSTED_APP_CHANNEL": JSON.stringify("latest"),
  },
  assetsInclude: ["**/*.wasm"],
  build: {
    emptyOutDir: true,
    outDir: resolve(here, "dist/browser"),
    // No prod sourcemap. The renderer map was 7 MB of the packaged app, shipped for
    // nobody: nothing reads it at runtime (no crash reporter, no source-map-support) and
    // dev debugging goes through the Vite dev server, which serves its own. Only
    // `dist/main/index.cjs.map` still ships — `scripts/smoke-packaged-app.mjs` reads its
    // `sourcesContent` to prove the packaged main bundle carries the code it claims.
    sourcemap: false,
    target: "chrome142",
  },
});
