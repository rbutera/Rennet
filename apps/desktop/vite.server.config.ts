import { cpSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { stageNativeArtifacts } from "../../scripts/native-artifact-staging.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// `@rennet/prompts` is INLINED into this bundle (not external), so at runtime the daemon
// cannot `require.resolve("@rennet/prompts")` to find its prompt `.md` files — the loader
// reads them off disk (the package is node-free by design; the caller owns the copy). So
// copy the prompt files next to the bundle; `create-server.ts` resolves them relative to
// its own dir when the resolve fails. Without this, every lens drafter hits ENOENT and no
// board is ever drafted in the packaged/spawned daemon.
function copyPromptFiles(): Plugin {
  return {
    name: "rennet-copy-prompt-files",
    closeBundle() {
      cpSync(
        resolve(here, "../../packages/prompts/src/prompts"),
        resolve(here, "dist/server/prompts"),
        { recursive: true },
      );
    },
  };
}

function copyNativeArtifacts(): Plugin {
  return {
    name: "rennet-copy-native-artifacts",
    closeBundle() {
      stageNativeArtifacts({
        sourceNativeRoot: resolve(here, "../../packages/adapters/dist/native"),
        bundleDirectory: resolve(here, "dist/server"),
        platform: process.platform,
        arch: process.arch,
      });
    },
  };
}

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
  plugins: [copyPromptFiles(), copyNativeArtifacts()],
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
    // No prod sourcemap: 6.5 MB (+2.3 MB for the SDK chunk) of the packaged app that
    // nothing reads — the daemon has no source-map-support and no crash reporter, and the
    // packaged-app smoke test reads `dist/main/index.cjs.map` only. See vite.main.config.ts.
    sourcemap: false,
    target: "node24",
  },
});
