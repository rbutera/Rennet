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

export default defineConfig({
  base: "./",
  root: resolve(here, "src/renderer"),
  plugins: [react(), tailwindcss()],
  resolve: {
    // The rung-two chat mount (@rennet/t3-chat) imports the vendored T3 Code web app by
    // module; its source addresses itself as `~/…`. One React for the whole renderer:
    // the vendored tree links the same 19.2.8, and dedupe makes that a guarantee.
    alias: { "~": resolve(t3Web, "src") },
    dedupe: ["react", "react-dom"],
  },
  define: {
    // Read at module scope by the vendored web source. Hosted-static mode is how T3's
    // own web app runs without a same-origin backend: the platform layer registers no
    // primary environment, and the ONLY environment is the sidecar the mount registers.
    "import.meta.env.APP_VERSION": JSON.stringify(t3WebVersion),
    "import.meta.env.VITE_HOSTED_APP_CHANNEL": JSON.stringify("latest"),
  },
  assetsInclude: ["**/*.wasm"],
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
